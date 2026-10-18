// Turns generated relief maps into GPU resources (textures, displaced LOD
// geometries, materials) and renders all panel placements with instancing and
// distance-based LOD + per-instance frustum culling.

import * as THREE from 'three';
import { generateRelief, RELIEF_H_MAX, RELIEF_H_MIN } from './ReliefGenerator';
import type { AnimalDef, ReliefMaps } from './ReliefTypes';
import { patchMaterial } from '../../materials/MaterialPatches';
import type { QualitySettings } from '../../core/Quality';

export interface ReliefAsset {
  key: string;
  maps: ReliefMaps;
  material: THREE.MeshStandardMaterial;
  /** [lod][mirrored ? 1 : 0] */
  geometries: THREE.BufferGeometry[][];
}

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, aniso: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function sampleHeight(m: ReliefMaps, u: number, v: number): number {
  // heights are stored top row first; v = 0 is the bottom of the panel
  const x = Math.min(m.width - 1.001, Math.max(0, u * (m.width - 1)));
  const y = Math.min(m.height - 1.001, Math.max(0, (1 - v) * (m.height - 1)));
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const fx = x - x0,
    fy = y - y0;
  const i = y0 * m.width + x0;
  const h00 = m.heights[i],
    h10 = m.heights[i + 1],
    h01 = m.heights[i + m.width],
    h11 = m.heights[i + m.width + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

/** Grid in the panel's local frame: x right, y up, z out of the wall. Origin = bottom-left. */
function panelGeometry(m: ReliefMaps, cell: number, mirrored: boolean, displaced: boolean): THREE.BufferGeometry {
  const sx = Math.max(1, Math.round(m.panelW / cell));
  const sy = Math.max(1, Math.round(m.panelH / cell));
  const nv = (sx + 1) * (sy + 1);
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const nor = new Float32Array(nv * 3);
  const tan = new Float32Array(nv * 4);
  let k = 0;
  for (let j = 0; j <= sy; j++) {
    const v = j / sy;
    for (let i = 0; i <= sx; i++) {
      const u = i / sx;
      const tu = mirrored ? 1 - u : u;
      const h = displaced ? Math.max(0, sampleHeight(m, tu, v)) : 0;
      pos[k * 3] = u * m.panelW;
      pos[k * 3 + 1] = v * m.panelH;
      pos[k * 3 + 2] = h;
      uv[k * 2] = tu;
      uv[k * 2 + 1] = v;
      nor[k * 3 + 2] = 1;
      tan[k * 4] = mirrored ? -1 : 1;
      tan[k * 4 + 3] = mirrored ? -1 : 1;
      k++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      const a = j * (sx + 1) + i;
      const b = a + 1;
      const c = a + sx + 1;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export class ReliefLibrary {
  readonly assets = new Map<string, ReliefAsset>();

  constructor(
    private quality: QualitySettings,
    private renderer: THREE.WebGLRenderer,
    private macro: THREE.Texture,
  ) {}

  get pxPerMetre(): number {
    return this.quality.level === 'low' ? 420 : this.quality.level === 'ultra' ? 760 : 620;
  }

  /** Generates several reliefs in parallel Web Workers (falls back to the main thread). */
  async generateAll(keys: readonly string[], fallback: (key: string) => AnimalDef): Promise<Map<string, ReliefMaps>> {
    const out = new Map<string, ReliefMaps>();
    const ppm = this.pxPerMetre;
    await Promise.all(
      keys.map(
        (key) =>
          new Promise<void>((resolve) => {
            try {
              const w = new Worker(new URL('./reliefWorker.ts', import.meta.url), { type: 'module' });
              w.onmessage = (e: MessageEvent<{ key: string; maps: ReliefMaps }>) => {
                out.set(e.data.key, e.data.maps);
                w.terminate();
                resolve();
              };
              w.onerror = () => {
                w.terminate();
                out.set(key, generateRelief(fallback(key), ppm));
                resolve();
              };
              w.postMessage({ key, ppm });
            } catch {
              out.set(key, generateRelief(fallback(key), ppm));
              resolve();
            }
          }),
      ),
    );
    return out;
  }

  build(key: string, def: AnimalDef, pre?: ReliefMaps): ReliefAsset {
    const maps = pre ?? generateRelief(def, this.pxPerMetre);
    const aniso = Math.min(this.quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    const albedo = dataTex(maps.albedo, maps.width, maps.height, true, aniso);
    const normal = dataTex(maps.normal, maps.width, maps.height, false, aniso);
    const orm = dataTex(maps.orm, maps.width, maps.height, false, aniso);
    const material = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      roughnessMap: orm,
      aoMap: orm,
      metalness: 0,
      roughness: 1,
      alphaTest: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    material.name = `relief:${key}`;
    patchMaterial(material, {
      weathering: { macro: this.macro, macroScale: 0.03, macroStrength: 0.3, dustHeight: 0.6, dustStrength: 0.45, topDust: 0.35 },
      bricks: { space: 'uv', value: 0.06, saturation: 0.1, roughness: 0.03, panelSize: new THREE.Vector2(maps.panelW, maps.panelH) },
      relief: {
        heightMap: orm,
        heightScale: RELIEF_H_MAX - RELIEF_H_MIN,
        uvPerMetre: new THREE.Vector2(1 / maps.panelW, 1 / maps.panelH),
        steps: Math.max(6, this.quality.reliefShadowSteps),
        softness: 6,
      },
    });
    const cells = [0.016, 0.05];
    const geometries: THREE.BufferGeometry[][] = [
      [panelGeometry(maps, cells[0], false, true), panelGeometry(maps, cells[0], true, true)],
      [panelGeometry(maps, cells[1], false, true), panelGeometry(maps, cells[1], true, true)],
      [panelGeometry(maps, 10, false, false), panelGeometry(maps, 10, true, false)],
    ];
    const asset: ReliefAsset = { key, maps, material, geometries };
    this.assets.set(key, asset);
    return asset;
  }
}

export interface PanelPlacement {
  asset: string;
  mirrored: boolean;
  matrix: THREE.Matrix4;
  center: THREE.Vector3;
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/** Draws placements with 3 LODs, re-bucketed every few frames. */
export class ReliefPanels {
  readonly group = new THREE.Group();
  private placements: PanelPlacement[] = [];
  private meshes = new Map<string, THREE.InstancedMesh[]>(); // key `${asset}|${mirror}` -> [near, mid, far]
  private frame = 0;
  near = 24;
  mid = 80;

  constructor(private lib: ReliefLibrary) {
    this.group.name = 'reliefPanels';
  }

  add(asset: string, mirrored: boolean, matrix: THREE.Matrix4): void {
    const a = this.lib.assets.get(asset);
    if (!a) throw new Error(`relief asset ${asset} missing`);
    const center = new THREE.Vector3(a.maps.panelW * 0.5, a.maps.panelH * 0.5, 0).applyMatrix4(matrix);
    this.placements.push({ asset, mirrored, matrix: matrix.clone(), center });
  }

  /** Call once after all add() calls. */
  finalize(): void {
    const counts = new Map<string, number>();
    for (const p of this.placements) {
      const k = `${p.asset}|${p.mirrored ? 1 : 0}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) {
      const [assetKey, m] = k.split('|');
      const a = this.lib.assets.get(assetKey)!;
      const meshes = [0, 1, 2].map((lod) => {
        const im = new THREE.InstancedMesh(a.geometries[lod][Number(m)], a.material, n);
        im.count = 0;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.castShadow = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.name = `relief:${k}:lod${lod}`;
        this.group.add(im);
        return im;
      });
      this.meshes.set(k, meshes);
    }
  }

  update(camera: THREE.PerspectiveCamera, force = false): void {
    if (!force && this.frame++ % 4 !== 0) return;
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (const ms of this.meshes.values()) for (const m of ms) m.count = 0;
    const cam = camera.position;
    for (const p of this.placements) {
      const a = this.lib.assets.get(p.asset)!;
      _sphere.center.copy(p.center);
      _sphere.radius = Math.max(a.maps.panelW, a.maps.panelH) * 0.6;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      const d = cam.distanceTo(p.center);
      const lod = d < this.near ? 0 : d < this.mid ? 1 : 2;
      const im = this.meshes.get(`${p.asset}|${p.mirrored ? 1 : 0}`)![lod];
      im.setMatrixAt(im.count++, p.matrix);
    }
    for (const ms of this.meshes.values())
      for (const m of ms) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, m.count * 16);
      }
  }
}
