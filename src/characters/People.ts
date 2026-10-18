// MakeHuman-based crowd assets (CC0 bodies, hair and beards fitted with MPFB,
// garments generated in Blender, CMU motion capture retargeted onto the rig):
//
//  * people_<type>.glb — one skinned mesh per archetype and LOD + mocap clips;
//  * people_atlas.webp — skins, eyes, brows, lashes, hair and beards.
//
// At load time every clip of every body type is sampled into ONE float
// texture of bone matrices (row = frame, 4 texels per bone), and the meshes
// become plain BufferGeometries with skin indices/weights and a part id. The
// crowd then draws all people of an archetype/LOD with one instanced draw
// call and skins them on the GPU from that texture.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type BodyType = 'male' | 'elder' | 'female';
export const BODY_TYPES: BodyType[] = ['male', 'elder', 'female'];

/** Vertex part ids (aPart); keep in sync with PeopleMaterial. */
export const PART = { skin: 0, eyes: 1, brows: 2, lashes: 3, hair: 4, beard: 5, cloth: 6, cloth2: 7, metal: 8, sleeve: 9, wood: 10, gold: 11, leather: 12, reed: 13, clay: 14 } as const;

export interface ClipInfo {
  frames: number;
  fps: number;
  loop: boolean;
  /** natural travel speed of the cycle (m/s), 0 for idles */
  speed: number;
  duration: number;
  /** first row in the bone texture */
  row: number;
}

export interface PeopleLibrary {
  /** archetype key -> [LOD0, LOD1, LOD2] geometries */
  meshes: Map<string, THREE.BufferGeometry[]>;
  /** archetype key -> body type */
  typeOf: Map<string, BodyType>;
  /** '<type>:<prop>' -> rigid prop geometry skinned to one bone */
  props: Map<string, THREE.BufferGeometry>;
  /** body type -> clip name -> info */
  clips: Record<BodyType, Record<string, ClipInfo>>;
  boneTexture: THREE.DataTexture;
  boneCount: number;
  atlas: THREE.Texture;
}

interface AtlasInfo {
  size: [number, number];
  rects: Record<string, [number, number, number, number]>;
}

const BASE = 'models/people/';

export async function loadPeople(renderer: THREE.WebGLRenderer, onProgress?: (f: number) => void): Promise<PeopleLibrary> {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_GLTF_CONFIG); // bundled by Vite (the glTF-only decoder)
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const [atlasInfo, atlas] = await Promise.all([
    fetch(BASE + 'people_atlas.json').then((r) => r.json() as Promise<AtlasInfo>),
    new THREE.TextureLoader().loadAsync(BASE + 'people_atlas.webp'),
  ]);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;

  const meshes = new Map<string, THREE.BufferGeometry[]>();
  const typeOf = new Map<string, BodyType>();
  const props = new Map<string, THREE.BufferGeometry>();
  const clips = {} as Record<BodyType, Record<string, ClipInfo>>;
  const rows: Float32Array[] = []; // one Float32Array per frame row
  let boneNames: string[] | null = null;
  let done = 0;

  for (const type of BODY_TYPES) {
    const [gltf, meta] = await Promise.all([
      loader.loadAsync(BASE + `people_${type}.glb`),
      fetch(BASE + `people_${type}.json`).then((r) => r.json() as Promise<{ clips: Record<string, Omit<ClipInfo, 'row'>> }>),
    ]);
    gltf.scene.updateMatrixWorld(true);
    const skinned: THREE.SkinnedMesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
    });
    if (!skinned.length) throw new Error(`people_${type}.glb has no skinned meshes`);
    const ref = skinned[0];
    const names = ref.skeleton.bones.map((b) => b.name);
    if (!boneNames) boneNames = names;
    const canon = new Map(boneNames.map((n, i) => [n, i]));

    // ---- geometry: merge the primitives of each archetype LOD
    const byKey = new Map<string, THREE.BufferGeometry[]>();
    const propParts = new Map<string, THREE.BufferGeometry[]>();
    for (const sm of skinned) {
      const pk = propKey(sm);
      if (pk) {
        const g = primitiveGeometry(sm, canon, atlasInfo);
        if (g) {
          if (!propParts.has(pk)) propParts.set(pk, []);
          propParts.get(pk)!.push(g);
        }
        continue;
      }
      const key = lodKey(sm);
      if (!key) continue;
      const g = primitiveGeometry(sm, canon, atlasInfo);
      if (!g) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(g);
    }
    for (const [key, list] of byKey) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const m = key.match(/^(.*)_LOD(\d)$/)!;
      const arch = m[1];
      const lod = Number(m[2]);
      if (!meshes.has(arch)) meshes.set(arch, []);
      meshes.get(arch)![lod] = merged;
      typeOf.set(arch, type);
    }

    for (const [pk, list] of propParts) {
      const merged = mergeGeometries(list, false);
      if (merged) props.set(`${type}:${pk}`, merged);
    }

    // ---- animation: sample every clip into bone-matrix rows
    const bones = boneNames.map((n) => ref.skeleton.bones.find((b) => b.name === n)!);
    const inverses = boneNames.map((n) => ref.skeleton.boneInverses[ref.skeleton.bones.findIndex((b) => b.name === n)]);
    const bind = ref.bindMatrix.clone();
    const bindInv = ref.bindMatrixInverse.clone();
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const m4 = new THREE.Matrix4();
    clips[type] = {};
    for (const [name, info] of Object.entries(meta.clips)) {
      const clip = gltf.animations.find((c) => c.name === name);
      if (!clip) {
        console.warn('[people] missing clip', type, name);
        continue;
      }
      const action = mixer.clipAction(clip);
      action.play();
      clips[type][name] = { ...info, row: rows.length };
      for (let f = 0; f < info.frames; f++) {
        mixer.setTime(f / info.fps);
        gltf.scene.updateMatrixWorld(true);
        const row = new Float32Array(boneNames.length * 16);
        for (let b = 0; b < bones.length; b++) {
          m4.multiplyMatrices(bones[b].matrixWorld, inverses[b]);
          m4.premultiply(bindInv).multiply(bind);
          row.set(m4.elements, b * 16);
        }
        rows.push(row);
      }
      action.stop();
      mixer.uncacheAction(clip);
    }
    onProgress?.(++done / BODY_TYPES.length);
  }
  draco.dispose();

  const nb = boneNames!.length;
  const width = nb * 4;
  const height = rows.length;
  const data = new Float32Array(width * height * 4);
  rows.forEach((r, y) => data.set(r, y * width * 4));
  const boneTexture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  boneTexture.minFilter = boneTexture.magFilter = THREE.NearestFilter;
  boneTexture.generateMipmaps = false;
  boneTexture.needsUpdate = true;
  return { meshes, typeOf, props, clips, boneTexture, boneCount: nb, atlas };
}

function propKey(o: THREE.Object3D): string | null {
  let p: THREE.Object3D | null = o;
  while (p) {
    const m = p.name.match(/^prop_([a-z]+)/);
    if (m) return m[1];
    p = p.parent;
  }
  return null;
}

function lodKey(o: THREE.Object3D): string | null {
  let p: THREE.Object3D | null = o;
  while (p) {
    const m = p.name.match(/^(.*_LOD\d)/);
    if (m) return m[1];
    p = p.parent;
  }
  return null;
}

/** One glTF primitive -> geometry with position, normal, uv, skinIndex/Weight (canonical bones), aPart. */
function primitiveGeometry(sm: THREE.SkinnedMesh, canon: Map<string, number>, atlas: AtlasInfo): THREE.BufferGeometry | null {
  const src = sm.geometry;
  const mat = (Array.isArray(sm.material) ? sm.material[0] : sm.material) as THREE.Material;
  const [partName, texKey] = mat.name.split(':');
  const part = PART[partName as keyof typeof PART];
  if (part === undefined) {
    console.warn('[people] unknown part', mat.name);
    return null;
  }
  const n = src.getAttribute('position').count;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', toFloat(src.getAttribute('position'), 3));
  g.setAttribute('normal', toFloat(src.getAttribute('normal'), 3));
  const uvIn = src.getAttribute('uv');
  const uv = new Float32Array(n * 2);
  const rect = texKey ? atlas.rects[`${partName}:${texKey}`] : undefined;
  let hem = Infinity;
  for (let i = 0; i < n; i++) {
    const u = uvIn ? uvIn.getX(i) : 0;
    const v = uvIn ? 1 - uvIn.getY(i) : 0; // back to Blender's bottom-up v
    if (rect) {
      uv[i * 2] = rect[0] + u * rect[2];
      uv[i * 2 + 1] = rect[1] + v * rect[3];
    } else {
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
      if (part === PART.cloth && v < 2) hem = Math.min(hem, v);
    }
  }
  // aPart = (part id, hem height of the garment)
  const partArr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) partArr[i * 2] = part;
  if (part === PART.cloth) {
    // garment space: (theta / 2pi, height above the hem); sleeves keep v >= 2
    for (let i = 0; i < n; i++) {
      partArr[i * 2 + 1] = hem;
      if (uv[i * 2 + 1] >= 2) partArr[i * 2] = PART.sleeve;
      else uv[i * 2 + 1] -= hem;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.BufferAttribute(partArr, 2));
  // skin indices -> canonical bone order
  const si = src.getAttribute('skinIndex');
  const sw = src.getAttribute('skinWeight');
  const local = sm.skeleton.bones.map((b) => canon.get(b.name) ?? 0);
  const idx = new Float32Array(n * 4);
  const wts = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = local[si.getComponent(i, k)] ?? 0;
      const w = sw.getComponent(i, k);
      wts[i * 4 + k] = w;
      s += w;
    }
    if (s > 0) for (let k = 0; k < 4; k++) wts[i * 4 + k] /= s;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(wts, 4));
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  // the mesh node may carry a transform relative to the rig: bake it into the bind pose space
  return g;
}

function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.BufferAttribute {
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, size);
}
