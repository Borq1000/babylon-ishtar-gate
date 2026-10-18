// Procedural date palms (Phoenix dactylifera): bark-textured curved trunks, crowns
// of pinnate fronds with a V cross-section, drooping dead fronds and date
// clusters. Instanced in a few variants with a near/far LOD; wind sways trunks
// and fronds in the vertex shader.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '../utils/math';
import { sharedUniforms, patchMaterial } from '../materials/MaterialPatches';
import type { MaterialLibrary } from '../materials/MaterialLibrary';

export const windUniforms = {
  uWind: { value: 0.45 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
};

/** Frond texture: rachis + lanceolate leaflets drawn on a canvas (alpha mask). */
function frondTexture(dead: boolean, chunky = false): THREE.CanvasTexture {
  const W = 256,
    H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  const rng = new Random(dead ? 7 : 3);
  // leaflets: from the rachis (x = W/2) towards the edges, pointing to the tip (y = 0)
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < (chunky ? 40 : 78); i++) {
      const t = i / 78; // 0 at the base (y = H) .. 1 at the tip
      const y0 = H * (1 - t) - 4;
      const len = W * 0.48 * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.15 + 0.08) * Math.PI)) * rng.range(0.85, 1.05);
      if (t < 0.12 && !dead) {
        // spines near the base
        ctx.strokeStyle = 'rgba(120,110,70,1)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(W / 2, y0);
        ctx.lineTo(W / 2 + side * len * 0.4, y0 - len * 0.25);
        ctx.stroke();
        continue;
      }
      const ang = (0.42 + rng.range(-0.06, 0.06)) * side; // leaflet angle towards the tip
      const x1 = W / 2 + Math.sin(ang) * len * 1.0 * side * side;
      const y1 = y0 - Math.cos(ang) * len * 1.1;
      const g = dead ? 90 + rng.range(-10, 20) : 115 + rng.range(-15, 15);
      const base = dead ? `rgb(${150 + rng.range(-20, 20)},${g},${55 + rng.range(-10, 10)})` : `rgb(${88 + rng.range(-12, 12)},${g},${86 + rng.range(-10, 14)})`;
      const grad = ctx.createLinearGradient(W / 2, y0, x1, y1);
      grad.addColorStop(0, base);
      grad.addColorStop(1, dead ? `rgb(170,140,90)` : `rgb(${130 + rng.range(-10, 10)},${150 + rng.range(-10, 10)},${120 + rng.range(-10, 10)})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      const wdt = (chunky ? 16 : 5.2) * rng.range(0.8, 1.2);
      ctx.moveTo(W / 2, y0);
      ctx.quadraticCurveTo((W / 2 + x1) / 2 + wdt * side, (y0 + y1) / 2 + wdt, x1, y1);
      ctx.quadraticCurveTo((W / 2 + x1) / 2 - wdt * side, (y0 + y1) / 2 - wdt, W / 2, y0 + 3);
      ctx.fill();
    }
  }
  // rachis
  const rg = ctx.createLinearGradient(0, H, 0, 0);
  rg.addColorStop(0, dead ? '#8a6a40' : '#9c9a62');
  rg.addColorStop(1, dead ? '#a88454' : '#7c8a5a');
  ctx.strokeStyle = rg;
  ctx.lineCap = 'round';
  for (let y = H; y > 0; y -= 8) {
    ctx.lineWidth = 2 + 7 * (y / H);
    ctx.beginPath();
    ctx.moveTo(W / 2, y);
    ctx.lineTo(W / 2, y - 9);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

interface PalmVariant {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  crownFar: THREE.BufferGeometry;
  height: number;
}

/** A frond as a V-folded ribbon along a drooping rachis curve. */
function frondGeometry(
  base: THREE.Vector3,
  yaw: number,
  pitch: number,
  length: number,
  width: number,
  droop: number,
  segs: number,
  vFold: number,
  dead: boolean,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const pts: THREE.Vector3[] = [];
  const ups: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // pitch decreases (droops) along the frond
    const a = pitch - droop * t * t;
    const p = new THREE.Vector3();
    if (i === 0) p.copy(base);
    else {
      const prev = pts[i - 1];
      const step = length / segs;
      const aMid = pitch - droop * Math.pow((i - 0.5) / segs, 2);
      p.copy(prev).addScaledVector(dir, Math.cos(aMid) * step).add(new THREE.Vector3(0, Math.sin(aMid) * step, 0));
    }
    pts.push(p);
    const tangent = dir.clone().multiplyScalar(Math.cos(a)).add(new THREE.Vector3(0, Math.sin(a), 0)).normalize();
    ups.push(new THREE.Vector3().crossVectors(side, tangent).normalize());
  }
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = width * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.1 + 0.1) * Math.PI)) * (dead ? 0.6 : 1);
    const p = pts[i];
    const up = ups[i];
    // left, centre, right: the leaflets rise from the rachis in a V
    const l = p.clone().addScaledVector(side, -w * 0.5).addScaledVector(up, w * vFold);
    const r = p.clone().addScaledVector(side, w * 0.5).addScaledVector(up, w * vFold);
    pos.push(l.x, l.y, l.z, p.x, p.y, p.z, r.x, r.y, r.z);
    uv.push(0, t, 0.5, t, 1, t);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    idx.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // attribute used by the wind shader: x = distance along frond (0..1), y = per-frond phase
  const n = pos.length / 3;
  const wind = new Float32Array(n * 2);
  const ph = Math.random() * 6.28;
  for (let i = 0; i < n; i++) {
    wind[i * 2] = uv[i * 2 + 1];
    wind[i * 2 + 1] = ph;
  }
  g.setAttribute('aWind', new THREE.BufferAttribute(wind, 2));
  return g;
}

function buildVariant(rng: Random, height: number, lean: number, fronds: number, far: boolean): PalmVariant {
  // curved, slightly tapering trunk
  const segsY = far ? 4 : 14,
    segsR = far ? 5 : 10;
  const bend = new THREE.Vector3(Math.cos(lean * 3) * lean, 0, Math.sin(lean * 3) * lean);
  const trunkGeo = new THREE.CylinderGeometry(0.21, 0.27, height, segsR, segsY, true);
  trunkGeo.translate(0, height / 2, 0);
  const tp = trunkGeo.getAttribute('position') as THREE.BufferAttribute;
  const tuv = trunkGeo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const t = y / height;
    tp.setX(i, tp.getX(i) * (1 + 0.15 * Math.max(0, 0.1 - t) * 10) + bend.x * t * t * height * 0.12);
    tp.setZ(i, tp.getZ(i) * (1 + 0.15 * Math.max(0, 0.1 - t) * 10) + bend.z * t * t * height * 0.12);
    // bark: 2 repeats around, height / 1.3 m vertically
    tuv.setXY(i, tuv.getX(i) * 2, (y / 1.3) * 1.0);
  }
  trunkGeo.computeVertexNormals();
  const topPos = new THREE.Vector3(bend.x * height * 0.12, height, bend.z * height * 0.12);
  // wind attr for the trunk: sway ∝ height²
  const tw = new Float32Array(tp.count * 2);
  for (let i = 0; i < tp.count; i++) tw[i * 2] = -Math.pow(tp.getY(i) / height, 2);
  trunkGeo.setAttribute('aWind', new THREE.BufferAttribute(tw, 2));

  const frondGeos: THREE.BufferGeometry[] = [];
  const n = far ? Math.round(fronds * 0.45) : fronds;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const yaw = i * 2.39996 + rng.range(-0.15, 0.15); // golden angle phyllotaxis
    // young fronds point up, older ones arch outwards and droop
    const age = rng.float();
    const pitch = THREE.MathUtils.lerp(1.15, -0.1, age) + rng.range(-0.1, 0.1);
    const len = rng.range(3.2, 4.6) * (0.75 + 0.25 * (1 - Math.abs(age - 0.5)));
    const droop = THREE.MathUtils.lerp(0.5, 1.3, age);
    const base = topPos.clone().add(new THREE.Vector3(Math.cos(yaw) * 0.25, -0.2 - age * 0.6, Math.sin(yaw) * 0.25));
    frondGeos.push(frondGeometry(base, yaw, pitch, len, rng.range(0.9, 1.2) * (far ? 2.0 : 1), droop, far ? 3 : 8, far ? 0.12 : 0.22, false));
    void t;
  }
  // a skirt of dead fronds hanging under the crown
  if (!far) {
    for (let i = 0; i < 7; i++) {
      const yaw = rng.range(0, Math.PI * 2);
      const base = topPos.clone().add(new THREE.Vector3(Math.cos(yaw) * 0.25, -0.9 - rng.range(0, 0.4), Math.sin(yaw) * 0.25));
      const g = frondGeometry(base, yaw, -1.15, rng.range(2.6, 3.4), 0.7, 0.2, 5, 0.1, true);
      // mark dead fronds via uv.x offset (shader picks the dead texture region)
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * 0.5 + 0.5);
      frondGeos.push(g);
    }
  }
  // living fronds use the left half of the atlas
  for (let i = 0; i < n; i++) {
    const uv = frondGeos[i].getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * 0.5);
  }
  const crown = mergeGeometries(frondGeos, false)!;
  // date clusters as small orange blobs
  if (!far) {
    const dates: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const yaw = rng.range(0, Math.PI * 2);
      const g = new THREE.SphereGeometry(0.28, 6, 5);
      g.scale(1, 1.5, 1);
      g.translate(topPos.x + Math.cos(yaw) * 0.55, topPos.y - 0.9, topPos.z + Math.sin(yaw) * 0.55);
      const nn = g.getAttribute('position').count;
      g.setAttribute('aWind', new THREE.BufferAttribute(new Float32Array(nn * 2), 2));
      const uvs = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < uvs.count; k++) uvs.setXY(k, 0.25, 0.02); // samples a solid bit of the rachis colour
      dates.push(g.toNonIndexed());
    }
    void dates;
  }
  return { trunk: trunkGeo, crown, crownFar: crown, height };
}

export class Palms {
  readonly group = new THREE.Group();
  private variants: PalmVariant[] = [];
  private farVariants: PalmVariant[] = [];
  private placements: { pos: THREE.Vector3; rot: number; scale: number; v: number }[] = [];
  private near: { trunk: THREE.InstancedMesh; crown: THREE.InstancedMesh }[] = [];
  private far: { trunk: THREE.InstancedMesh; crown: THREE.InstancedMesh }[] = [];
  private frame = 0;
  nearDistance = 170;
  maxDistance = 2600;

  constructor(private mats: MaterialLibrary) {
    this.group.name = 'palms';
  }

  add(x: number, z: number, scale = 1, y = 0): void {
    const v = Math.floor(Math.random() * 6);
    this.placements.push({ pos: new THREE.Vector3(x, y, z), rot: Math.random() * Math.PI * 2, scale, v });
  }

  /** Scatters a grove inside a rectangle avoiding a predicate. */
  grove(x0: number, z0: number, x1: number, z1: number, spacing: number, rng: Random, avoid?: (x: number, z: number) => boolean): void {
    for (let z = z0; z < z1; z += spacing) {
      for (let x = x0; x < x1; x += spacing) {
        const px = x + rng.range(-spacing * 0.42, spacing * 0.42);
        const pz = z + rng.range(-spacing * 0.42, spacing * 0.42);
        if (avoid?.(px, pz)) continue;
        if (rng.chance(0.15)) continue;
        this.add(px, pz, rng.range(0.75, 1.15));
      }
    }
  }

  build(): void {
    const rng = new Random(42);
    for (let i = 0; i < 6; i++) {
      const h = rng.range(9, 17);
      const lean = rng.range(0.05, 0.45);
      const f = rng.int(30, 38);
      this.variants.push(buildVariant(new Random(100 + i), h, lean, f, false));
      this.farVariants.push(buildVariant(new Random(100 + i), h, lean, f, true));
    }
    const live = frondTexture(false);
    const dead = frondTexture(true);
    // atlas: left = living, right = dead
    const atlas = document.createElement('canvas');
    atlas.width = 512;
    atlas.height = 1024;
    const actx = atlas.getContext('2d')!;
    actx.drawImage(live.image as HTMLCanvasElement, 0, 0);
    actx.drawImage(dead.image as HTMLCanvasElement, 256, 0);
    const atlasTex = new THREE.CanvasTexture(atlas);
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.anisotropy = 4;

    const farAtlas = document.createElement('canvas');
    farAtlas.width = 512;
    farAtlas.height = 1024;
    const fctx = farAtlas.getContext('2d')!;
    fctx.drawImage(frondTexture(false, true).image as HTMLCanvasElement, 0, 0);
    fctx.drawImage(frondTexture(true, true).image as HTMLCanvasElement, 256, 0);
    const farTex = new THREE.CanvasTexture(farAtlas);
    farTex.colorSpace = THREE.SRGBColorSpace;
    const frondMat = new THREE.MeshStandardMaterial({
      map: atlasTex,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0,
      envMapIntensity: 0.8,
    });
    const bark = this.mats.ext['bark'];
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0xc9a27a,
      map: bark?.map ?? null,
      normalMap: bark?.normalMap ?? null,
      roughness: 0.95,
      metalness: 0,
    });
    const frondFar = new THREE.MeshStandardMaterial({ map: farTex, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.7, metalness: 0, envMapIntensity: 0.8 });
    for (const m of [frondMat, trunkMat, frondFar]) this.windPatch(m, m !== trunkMat);
    patchMaterial(frondFar, { extraKey: 'palmFrondFar' });
    patchMaterial(trunkMat, { extraKey: 'palmTrunk' });
    patchMaterial(frondMat, { extraKey: 'palmFrond' });
    const depthFrond = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlasTex, alphaTest: 0.45, side: THREE.DoubleSide });
    this.windPatch(depthFrond, true);
    const depthTrunk = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.windPatch(depthTrunk, false);

    const counts = new Array(6).fill(0);
    for (const p of this.placements) counts[p.v]++;
    for (let i = 0; i < 6; i++) {
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(geo, mat, Math.max(1, counts[i]));
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = shadow;
        im.receiveShadow = true;
        im.customDepthMaterial = depth;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
        return im;
      };
      this.near.push({
        trunk: mk(this.variants[i].trunk, trunkMat, depthTrunk, true),
        crown: mk(this.variants[i].crown, frondMat, depthFrond, true),
      });
      this.far.push({
        trunk: mk(this.farVariants[i].trunk, trunkMat, depthTrunk, false),
        crown: mk(this.farVariants[i].crown, frondFar, depthFrond, false),
      });
    }
  }

  private windPatch(mat: THREE.Material, frond: boolean): void {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev.call(mat, shader, r);
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uWind = windUniforms.uWind;
      shader.uniforms.uWindDir = windUniforms.uWindDir;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec2 aWind;
uniform float uTime; uniform float uWind; uniform vec2 uWindDir;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  float inst = 0.0;
  #ifdef USE_INSTANCING
    inst = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.07;
  #endif
  float gust = 0.6 + 0.4 * sin(uTime * 0.5 + inst * 0.3) * sin(uTime * 0.23 + inst);
  vec3 wd = vec3(uWindDir.x, 0.0, uWindDir.y);
  ${
    frond
      ? `float t = aWind.x;
  float ph = aWind.y + inst;
  float flutter = sin(uTime * 2.6 + ph * 3.0 + t * 4.0) * 0.06 + sin(uTime * 5.3 + ph * 7.0 + t * 9.0) * 0.025;
  float bendW = uWind * gust * t * t;
  transformed += wd * bendW * 0.55 + vec3(0.0, -bendW * 0.25 + flutter * t * (0.6 + uWind), 0.0);
  transformed.xz += vec2(flutter, -flutter) * t * uWind;`
      : `float t = -aWind.x;
  transformed += wd * uWind * gust * t * 0.18 + vec3(sin(uTime * 0.9 + inst), 0.0, cos(uTime * 0.7 + inst)) * 0.04 * t * uWind;`
  }
  ${frond ? '' : ''}
}`,
        );
      // fronds also follow the trunk sway at the crown
      if (frond)
        shader.vertexShader = shader.vertexShader.replace(
          '// fronds-follow',
          '',
        );
    };
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => prevKey() + (frond ? '|windFrond' : '|windTrunk');
  }

  update(camera: THREE.PerspectiveCamera, force = false): void {
    if (!force && this.frame++ % 6 !== 0) return;
    for (const g of [...this.near, ...this.far]) {
      g.trunk.count = 0;
      g.crown.count = 0;
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const cam = camera.position;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    for (const p of this.placements) {
      const d = cam.distanceTo(p.pos);
      if (d > this.maxDistance) continue;
      sphere.center.set(p.pos.x, p.pos.y + 8 * p.scale, p.pos.z);
      sphere.radius = 10 * p.scale;
      if (!frustum.intersectsSphere(sphere)) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      m.compose(p.pos, q, s.setScalar(p.scale));
      const g = d < this.nearDistance ? this.near[p.v] : this.far[p.v];
      g.trunk.setMatrixAt(g.trunk.count++, m);
      g.crown.setMatrixAt(g.crown.count++, m);
    }
    for (const g of [...this.near, ...this.far]) {
      g.trunk.instanceMatrix.needsUpdate = true;
      g.crown.instanceMatrix.needsUpdate = true;
    }
  }

  get count(): number {
    return this.placements.length;
  }
}
