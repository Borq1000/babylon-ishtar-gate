// Market stalls with wind-blown linen awnings on the plaza beyond the gate and
// near the North Gate. Goods are CC0 Poly Haven models (clay storage jars,
// wicker baskets, carved bowls) loaded with GLTFLoader and drawn instanced.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries as merge } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '../utils/math';
import { sharedUniforms, patchMaterial } from '../materials/MaterialPatches';
import { windUniforms } from './Palms';
import type { MaterialLibrary } from '../materials/MaterialLibrary';

export interface StallSpot {
  x: number;
  z: number;
  rot: number;
}

const CLOTH = [0xd9cfb8, 0xc4ab82, 0x9e3b22, 0xb8862f, 0xe6dccb, 0x6e4b33];

export class Market {
  readonly group = new THREE.Group();
  private rng = new Random(77);
  private props: THREE.InstancedMesh[] = [];
  private centre = new THREE.Vector3();

  constructor(
    private mats: MaterialLibrary,
    private spots: StallSpot[],
  ) {
    this.group.name = 'market';
  }

  async build(): Promise<void> {
    const rng = this.rng;
    for (const s of this.spots) this.centre.add(new THREE.Vector3(s.x, 0, s.z));
    this.centre.multiplyScalar(1 / Math.max(1, this.spots.length));
    const awnings: THREE.BufferGeometry[] = [];
    const poles: THREE.BufferGeometry[] = [];
    const mats: THREE.BufferGeometry[] = [];
    for (const s of this.spots) {
      const m = new THREE.Matrix4().makeRotationY(s.rot).setPosition(s.x, 0, s.z);
      // awning: sagging cloth, back edge high on poles, front edge on poles
      const w = rng.range(2.6, 3.4),
        d = rng.range(2.0, 2.6);
      const g = new THREE.PlaneGeometry(w, d, 10, 8).rotateX(-Math.PI / 2);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const pin = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i),
          z = pos.getZ(i);
        const u = x / w + 0.5,
          v = z / d + 0.5;
        const sag = Math.sin(u * Math.PI) * 0.12 + Math.sin(v * Math.PI) * 0.08;
        pos.setY(i, 2.15 + (0.5 - v) * 0.45 - sag);
        // free-ness for the wind: zero at the four corners / edges tied to poles
        pin[i] = Math.sin(u * Math.PI) * (0.35 + 0.65 * v);
      }
      g.setAttribute('aPin', new THREE.BufferAttribute(pin, 1));
      const col = new THREE.Color().setHex(rng.pick(CLOTH), THREE.SRGBColorSpace);
      const stripe = rng.chance(0.5);
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) / w + 0.5;
        const c = stripe && Math.floor(u * 7) % 2 === 0 ? col.clone().multiplyScalar(0.62) : col;
        colors.set([c.r, c.g, c.b], i * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.computeVertexNormals();
      g.applyMatrix4(m);
      awnings.push(g);
      for (const [px, pz, h] of [
        [-w / 2, d / 2, 2.0],
        [w / 2, d / 2, 2.0],
        [-w / 2, -d / 2, 2.4],
        [w / 2, -d / 2, 2.4],
      ]) {
        const pg = new THREE.CylinderGeometry(0.035, 0.04, h, 6).translate(px, h / 2, pz);
        pg.applyMatrix4(m);
        poles.push(pg);
      }
      const mat = new THREE.BoxGeometry(w * 0.9, 0.04, d * 0.8).translate(0, 0.02, 0);
      mat.applyMatrix4(m);
      mats.push(mat);
    }
    // awning cloth with a wind shader
    const clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    const fab = this.mats.ext['fabric'];
    if (fab?.map) {
      clothMat.map = fab.map;
      clothMat.normalMap = fab.normalMap ?? null;
    }
    clothMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uWind = windUniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPin;\nuniform float uTime;\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float wv = sin(uTime * 2.1 + position.x * 1.3 + position.z * 0.9) * 0.6 + sin(uTime * 3.7 + position.x * 2.1) * 0.4;
           transformed.y += wv * aPin * (0.05 + uWind * 0.12);`,
        );
    };
    clothMat.customProgramCacheKey = () => 'awning';
    patchMaterial(clothMat, { extraKey: 'awning' });
    const awningMesh = new THREE.Mesh(merge(awnings.map((g) => g.toNonIndexed()), false)!, clothMat);
    awningMesh.castShadow = true;
    awningMesh.receiveShadow = true;
    this.group.add(awningMesh);
    const poleMesh = new THREE.Mesh(merge(poles, false)!, this.mats.wood);
    poleMesh.castShadow = true;
    this.group.add(poleMesh);
    const reed = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHex(0x9c8152, THREE.SRGBColorSpace), roughness: 0.95 });
    const matMesh = new THREE.Mesh(merge(mats, false)!, reed);
    matMesh.receiveShadow = true;
    this.group.add(matMesh);

    await this.goods();
  }

  /** Instanced CC0 props (jars, baskets, bowls) from the local Poly Haven models. */
  private async goods(): Promise<void> {
    const loader = new GLTFLoader();
    const load = (url: string) =>
      new Promise<THREE.Mesh | null>((resolve) =>
        loader.load(
          url,
          (gltf) => {
            let found: THREE.Mesh | null = null;
            gltf.scene.traverse((o) => {
              if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
            });
            resolve(found);
          },
          undefined,
          () => resolve(null),
        ),
      );
    const [pot, basket, bowl] = await Promise.all([
      load('/models/ph/planter_pot_clay/planter_pot_clay_1k.gltf'),
      load('/models/ph/wicker_basket_02/wicker_basket_02_1k.gltf'),
      load('/models/ph/wooden_bowl_01/wooden_bowl_01_1k.gltf'),
    ]);
    const rng = this.rng;
    const place = (mesh: THREE.Mesh | null, perStall: number, scaleRange: [number, number], spread: number, shadow: boolean, every = 1) => {
      if (!mesh) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!;
      const lift = -bb.min.y;
      const stalls = this.spots.filter((_, i) => i % every === 0);
      const n = stalls.length * perStall;
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, n);
      const m = new THREE.Matrix4();
      let k = 0;
      for (const s of stalls) {
        for (let i = 0; i < perStall; i++) {
          const lx = rng.range(-spread, spread),
            lz = rng.range(-0.6, 0.9);
          const c = Math.cos(s.rot),
            sn = Math.sin(s.rot);
          const sc = rng.range(scaleRange[0], scaleRange[1]);
          m.compose(
            new THREE.Vector3(s.x + lx * c + lz * sn, lift * sc + 0.04, s.z - lx * sn + lz * c),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2)),
            new THREE.Vector3(sc, sc, sc),
          );
          im.setMatrixAt(k++, m);
        }
      }
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.props.push(im);
      this.group.add(im);
    };
    // the scanned assets are dense (bowl 14k, basket 18k triangles): use them sparingly
    place(pot, 3, [1.4, 2.4], 1.2, true);
    place(basket, 1, [0.9, 1.25], 1.1, false, 2);
    void bowl;
  }

  /** Hide the dense props when the viewer is far away. */
  update(viewer: THREE.Vector3): void {
    const far = viewer.distanceTo(this.centre) > 140;
    for (const p of this.props) p.visible = !far;
  }
}
