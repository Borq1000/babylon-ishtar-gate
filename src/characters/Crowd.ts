// The people of Babylon: the Akitu procession escorting the god's statue to the
// Ishtar Gate, passers-by in both directions, spectators along the walls,
// guards at the gates and sentries on the wall walks, and townsfolk on the
// plaza. Agents are simulated on the CPU; the people themselves are MakeHuman
// bodies (CC0) in Blender-built Neo-Babylonian garments, animated with CMU
// motion capture, drawn as GPU-skinned InstancedMeshes in three LODs that are
// re-bucketed every frame with frustum culling (see People.ts).

import * as THREE from 'three';
import { Random, clamp, dampFactor, lerp, smoothstep } from '../utils/math';
import type { BodyType, ClipInfo, PeopleLibrary } from './People';
import { makePeopleDepthMaterial, makePeopleMaterial, makeShadowProxyMaterial } from './PeopleMaterial';
import { LAYOUT } from '../world/Layout';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import { applyWorldUV } from '../utils/geometry';
import { canopyCloth, goldSheet, lapisPanel } from './PalanquinTextures';

type Role = 'procession' | 'walker' | 'spectator' | 'guard' | 'sentry' | 'plaza';

interface Agent {
  /** index into the per-person colour texture */
  id: number;
  /** behaviour key (man, guard, drummer, ...) */
  key: string;
  /** visual archetype index (mesh) */
  vis: number;
  type: BodyType;
  walkClip: string;
  idleClip: string;
  /** clip phases 0..1 */
  phaseW: number;
  phaseI: number;
  /** 0..1: waving / gesturing towards the procession */
  gesture: number;
  canWave: boolean;
  /** prop mesh keys ('<type>:<prop>') carried by this agent */
  props: string[];
  role: Role;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  baseSpeed: number;
  stride: number;
  cyc: number;
  walk: number;
  scale: number;
  seed: number;
  colA: [number, number, number, number];
  colB: [number, number, number, number];
  colC: [number, number, number, number];
  // role data
  laneX?: number;
  dir?: number;
  fdx?: number;
  fdz?: number;
  homeZ?: number;
  range?: number;
  faceX?: number;
  faceZ?: number;
  active: boolean;
}

// ---------------------------------------------------------------- palettes (linear)
const P = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
const COMMON = [P(0.72, 0.66, 0.55), P(0.62, 0.52, 0.38), P(0.42, 0.3, 0.19), P(0.28, 0.19, 0.12), P(0.5, 0.13, 0.08), P(0.6, 0.42, 0.16), P(0.32, 0.33, 0.24), P(0.78, 0.74, 0.64)];
const ACCENTS = [P(0.46, 0.1, 0.06), P(0.58, 0.4, 0.13), P(0.1, 0.12, 0.22), P(0.76, 0.72, 0.62), P(0.26, 0.08, 0.17), P(0.2, 0.26, 0.18)];
const HEADWEAR = [P(0.82, 0.78, 0.68), P(0.72, 0.64, 0.5), P(0.55, 0.12, 0.08), P(0.62, 0.45, 0.17), P(0.15, 0.13, 0.12)];
const LINEN = P(0.86, 0.84, 0.78);
const NOBLE = [P(0.3, 0.07, 0.2), P(0.48, 0.08, 0.06), P(0.14, 0.1, 0.32)];

export class Crowd {
  readonly group = new THREE.Group();
  private agents: Agent[] = [];
  private meshes: THREE.InstancedMesh[][] = []; // [visual][lod]
  private attrs: Record<string, THREE.InstancedBufferAttribute>[][] = [];
  private rng = new Random(2501);
  private palanquin = new THREE.Group();
  /** z of the procession head (moving south, -Z). */
  processionZ = 24;
  processionSpeed = 0.72;
  readonly processionPos = new THREE.Vector3();
  readonly censers: THREE.Vector3[] = [];
  readonly crowdSpots: THREE.Vector3[] = [];
  nearDistance = 10;
  midDistance = 32;
  farDistance = 75;
  private visuals: string[] = [];
  private propMeshes = new Map<string, { im: THREE.InstancedMesh; at: Record<string, THREE.InstancedBufferAttribute> }>();
  private shadowProxies: { im: THREE.InstancedMesh; at: Record<string, THREE.InstancedBufferAttribute> }[] = [];
  /** people farther than this cast no shadow */
  shadowDistance = 110;
  /** Lateral distance walkers keep from the camera (0 = only the short-range push). */
  cameraClearance = 0;
  maxDistance = 420;
  fraction = 1;
  private cam = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private sV = new THREE.Vector3();
  private pV = new THREE.Vector3();
  private sphere = new THREE.Sphere();

  constructor(
    private mats: MaterialLibrary,
    private people: PeopleLibrary,
  ) {
    this.group.name = 'crowd';
  }

  build(): void {
    this.visuals = [...this.people.meshes.keys()];
    this.populate();
    // per-person colours never change: one static texture instead of per-frame attributes
    const agentData = new Float32Array(this.agents.length * 3 * 4);
    this.agents.forEach((a, i) => {
      a.id = i;
      agentData.set(a.colA, i * 12);
      agentData.set(a.colB, i * 12 + 4);
      agentData.set(a.colC, i * 12 + 8);
    });
    const agentTex = new THREE.DataTexture(agentData, this.agents.length * 3, 1, THREE.RGBAFormat, THREE.FloatType);
    agentTex.minFilter = agentTex.magFilter = THREE.NearestFilter;
    agentTex.needsUpdate = true;
    const mat = makePeopleMaterial(this.people, agentTex, 1.38, 0.9);
    const depth = makePeopleDepthMaterial(this.people);
    const proxyMat = makeShadowProxyMaterial();
    const counts = new Array(this.visuals.length).fill(0);
    for (const a of this.agents) counts[a.vis]++;
    this.visuals.forEach((key, v) => {
      const lods: THREE.InstancedMesh[] = [];
      const lodAttrs: Record<string, THREE.InstancedBufferAttribute>[] = [];
      const geos = this.people.meshes.get(key)!;
      geos.forEach((src, lod) => {
        const geo = src.clone();
        const n = Math.max(1, counts[v]);
        const at: Record<string, THREE.InstancedBufferAttribute> = {};
        for (const name of ['iAnimA', 'iAnimB']) {
          const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
          attr.setUsage(THREE.DynamicDrawUsage);
          geo.setAttribute(name, attr);
          at[name] = attr;
        }
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = false; // shadows come from the LOD2 proxies below
        im.receiveShadow = true;
        im.customDepthMaterial = depth;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.name = `people:${key}:${lod}`;
        this.group.add(im);
        lods.push(im);
        lodAttrs.push(at);
      });
      this.meshes.push(lods);
      this.attrs.push(lodAttrs);
      // shadow proxy: LOD2 geometry for every person within shadow range (also off-screen),
      // skinned only in the shadow pass
      const pgeo = geos[geos.length - 1].clone();
      const n = Math.max(1, counts[v]);
      const pat: Record<string, THREE.InstancedBufferAttribute> = {};
      for (const name of ['iAnimA', 'iAnimB']) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        attr.setUsage(THREE.DynamicDrawUsage);
        pgeo.setAttribute(name, attr);
        pat[name] = attr;
      }
      const proxy = new THREE.InstancedMesh(pgeo, proxyMat, n);
      proxy.count = 0;
      proxy.frustumCulled = false;
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.customDepthMaterial = depth;
      proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      proxy.name = `peopleShadow:${key}`;
      this.group.add(proxy);
      this.shadowProxies.push({ im: proxy, at: pat });
    });
    // hand-held props: one instanced mesh per prop, skinned to the carrier's bones
    const propCounts = new Map<string, number>();
    for (const a of this.agents) for (const k of a.props) propCounts.set(k, (propCounts.get(k) ?? 0) + 1);
    for (const [k, n] of propCounts) {
      const geo = this.people.props.get(k)!.clone();
      const at: Record<string, THREE.InstancedBufferAttribute> = {};
      for (const name of ['iAnimA', 'iAnimB']) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        attr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(name, attr);
        at[name] = attr;
      }
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = /spear|shield|standard|staff|basket|jar/.test(k);
      im.receiveShadow = true;
      im.customDepthMaterial = depth;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = `prop:${k}`;
      this.group.add(im);
      this.propMeshes.set(k, { im, at });
    }
    this.buildPalanquin();
    this.group.add(this.palanquin);
  }

  // ---------------------------------------------------------------- agents
  /** Visual archetype, clips and props for a behaviour key. */
  private visualFor(key: string, role: Role): { mesh: string; walk: string; idle: string; props: string[] } {
    const rng = this.rng;
    const proc = role === 'procession';
    const talk = () => (rng.chance(0.4) ? 'talk' : 'idle');
    switch (key) {
      case 'guard':
        return { mesh: 'guard', walk: 'march_spear', idle: 'idle_spear', props: ['spear', 'shield'] };
      case 'priest':
        return { mesh: 'priest', walk: 'walk_censer', idle: 'walk_censer', props: ['censer'] };
      case 'standard':
        return { mesh: 'noble', walk: 'walk_standard', idle: 'walk_standard', props: ['standard'] };
      case 'drummer':
        return { mesh: rng.chance(0.5) ? 'man' : 'robed', walk: 'walk_drum', idle: 'walk_drum', props: ['drum'] };
      case 'lyrist':
        return { mesh: rng.chance(0.5) ? 'man' : 'robed', walk: 'walk_lyre', idle: 'walk_lyre', props: ['lyre'] };
      case 'bearer':
        return { mesh: 'worker', walk: 'walk_bearer', idle: 'walk_bearer', props: [] };
      case 'noble':
        return { mesh: 'noble', walk: 'walk_staff', idle: 'idle_staff', props: ['staff'] };
      case 'elder':
        return { mesh: 'elder', walk: 'walk_staff', idle: 'idle_staff', props: ['staff'] };
      case 'porter':
        return { mesh: 'worker', walk: 'walk_carry', idle: 'idle_carry', props: ['basket'] };
      case 'womanJar':
        return { mesh: 'woman', walk: 'walk_carry', idle: 'idle_carry', props: ['jar'] };
      case 'woman':
        return { mesh: 'woman', walk: proc ? 'walk_slow' : 'walk', idle: talk(), props: [] };
      case 'merchant':
        return { mesh: 'robed', walk: 'walk', idle: talk(), props: [] };
      default:
        return { mesh: rng.chance(0.5) ? 'man' : 'robed', walk: proc ? 'walk_slow' : 'walk', idle: talk(), props: [] };
    }
  }

  private agent(key: string, role: Role, x: number, z: number, heading: number): Agent {
    const rng = this.rng;
    const look = this.visualFor(key, role);
    const vis = Math.max(0, this.visuals.indexOf(look.mesh));
    const type = this.people.typeOf.get(this.visuals[vis]) ?? 'male';
    const garment = key === 'priest' ? LINEN : key === 'noble' || key === 'standard' ? rng.pick(NOBLE) : key === 'guard' ? rng.pick([P(0.5, 0.12, 0.08), P(0.6, 0.42, 0.16), P(0.55, 0.47, 0.35)]) : rng.pick(COMMON);
    const accent = key === 'priest' ? P(0.86, 0.84, 0.78) : key === 'noble' || key === 'standard' ? P(0.72, 0.5, 0.14) : rng.pick(ACCENTS);
    const head = key === 'priest' ? LINEN : key === 'woman' || key === 'womanJar' ? rng.pick([...COMMON, ...ACCENTS]) : rng.pick(HEADWEAR);
    const scale = rng.range(0.95, 1.05);
    return {
      id: 0,
      key,
      vis,
      type,
      walkClip: look.walk,
      idleClip: look.idle,
      phaseW: rng.float(),
      phaseI: rng.float(),
      gesture: 0,
      canWave: look.props.length === 0 && rng.chance(0.35),
      props: look.props.map((p) => `${type}:${p}`).filter((k) => this.people.props.has(k)),
      role,
      x,
      y: 0,
      z,
      heading,
      speed: 0,
      baseSpeed: rng.range(1.15, 1.5),
      stride: 0.7,
      cyc: 0,
      walk: 0,
      scale,
      seed: rng.range(0, 100),
      colA: [...garment, rng.range(0.25, 0.75)],
      colB: [...accent, key === 'elder' ? rng.range(0.6, 1) : rng.range(0, 0.6)],
      colC: [...head, key === 'elder' ? 2 + rng.float() : rng.float()],
      active: true,
    };
  }

  private populate(): void {
    const rng = this.rng;
    const R = LAYOUT.road;
    // --- the Akitu procession: [key, dx, dz behind the head]
    const formation: [string, number, number][] = [];
    const row = (dz: number, key: string, xs: number[]) => xs.forEach((x) => formation.push([key, x, dz]));
    row(0, 'guard', [-2.4, 2.4]);
    row(2.6, 'standard', [-1.5, 0, 1.5]);
    row(5.4, 'drummer', [-2.2, -0.75, 0.75, 2.2]);
    row(7.8, 'lyrist', [-1.1, 1.1]);
    row(7.8, 'drummer', [-2.6, 2.6]);
    row(10.6, 'priest', [-1.6, -0.55, 0.55, 1.6]);
    row(12.8, 'priest', [-1.6, -0.55, 0.55, 1.6]);
    // palanquin bearers around the litter (centre at dz = 17.4)
    row(15.6, 'bearer', [-0.95, 0.95]);
    row(16.8, 'bearer', [-0.95, 0.95]);
    row(18.0, 'bearer', [-0.95, 0.95]);
    row(19.2, 'bearer', [-0.95, 0.95]);
    row(17.4, 'guard', [-3.6, 3.6]);
    row(22.4, 'priest', [-1.2, 0, 1.2]);
    row(25.0, 'noble', [-2.0, -0.7, 0.7, 2.0]);
    row(27.6, 'noble', [-1.4, 0, 1.4]);
    row(30.4, 'guard', [-2.6, 2.6]);
    for (let i = 0; i < 16; i++) formation.push([rng.pick(['man', 'man', 'woman', 'elder', 'man', 'woman']), rng.range(-3.2, 3.2), 33 + rng.range(0, 13)]);
    for (const [key, dx, dz] of formation) {
      const a = this.agent(key, 'procession', dx, this.processionZ + dz, Math.PI);
      a.fdx = dx;
      a.fdz = dz;
      a.baseSpeed = this.processionSpeed;
      if (key === 'priest') this.censers.push(new THREE.Vector3());
      this.agents.push(a);
    }

    // --- passers-by in both directions along the walls
    const walkerKeys = ['man', 'man', 'woman', 'womanJar', 'porter', 'merchant', 'elder', 'man', 'woman', 'porter'];
    for (let i = 0; i < 74; i++) {
      const dir = rng.chance(0.5) ? 1 : -1;
      const laneX = (rng.chance(0.5) ? -1 : 1) * rng.range(5.6, 9.6);
      const z = rng.range(-300, 228);
      const a = this.agent(rng.pick(walkerKeys), 'walker', laneX, z, dir > 0 ? 0 : Math.PI);
      a.laneX = laneX;
      a.dir = dir;
      this.agents.push(a);
    }

    // --- spectators in small groups along the walls, facing the street
    for (let g = 0; g < 26; g++) {
      const side = g % 2 === 0 ? -1 : 1;
      const z = 12 + g * 6.2 + rng.range(-2, 2);
      const n = rng.int(2, 4);
      const baseX = side * rng.range(9.0, 10.2);
      if (side < 0 && z > 100) continue; // keep the lion frieze clear for close views
      for (let k = 0; k < n; k++) {
        const x = baseX + rng.range(-0.7, 0.7);
        const zz = z + rng.range(-1.2, 1.2);
        const a = this.agent(rng.pick(['man', 'woman', 'elder', 'man', 'woman', 'merchant']), 'spectator', x, zz, 0);
        a.faceX = x - side * 3 + rng.range(-1, 1);
        a.faceZ = zz + rng.range(-2, 2);
        this.agents.push(a);
      }
      this.crowdSpots.push(new THREE.Vector3(baseX, 1.6, z));
    }

    // --- guards at the gates
    const F = LAYOUT.frontGate;
    for (const [x, z] of [
      [-3.0, 5.4],
      [3.0, 5.4],
      [-5.6, 4.6],
      [5.6, 4.6],
      [-2.0, LAYOUT.rearGate.zFront - LAYOUT.rearGate.depth - 2.5],
      [2.0, LAYOUT.rearGate.zFront - LAYOUT.rearGate.depth - 2.5],
      [-3.4, LAYOUT.northGate.z0 - 3],
      [3.4, LAYOUT.northGate.z0 - 3],
    ]) {
      const a = this.agent('guard', 'guard', x, z, z > 0 ? 0 : Math.PI);
      a.faceX = x;
      a.faceZ = z + (z > 0 ? 10 : -10);
      this.agents.push(a);
    }
    void F;
    // --- sentries pacing on the wall walks
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (R.halfWidth + 2.2);
      const homeZ = 14 + i * 16;
      const a = this.agent('guard', 'sentry', x, homeZ, 0);
      a.y = LAYOUT.procWall.height;
      a.homeZ = homeZ;
      a.range = rng.range(5, 9);
      a.dir = rng.chance(0.5) ? 1 : -1;
      a.baseSpeed = rng.range(0.55, 0.8);
      this.agents.push(a);
    }

    // --- townsfolk on the plaza beyond the main gate
    const zB = LAYOUT.rearGate.zFront - LAYOUT.rearGate.depth;
    for (let g = 0; g < 9; g++) {
      const cx = rng.range(-50, 18),
        cz = rng.range(zB - 48, zB - 8);
      if (Math.abs(cx) < 6) continue;
      const n = rng.int(2, 5);
      for (let k = 0; k < n; k++) {
        const x = cx + rng.range(-1.4, 1.4),
          z = cz + rng.range(-1.4, 1.4);
        const a = this.agent(rng.pick(['man', 'woman', 'merchant', 'elder', 'womanJar', 'porter']), 'plaza', x, z, 0);
        a.faceX = cx + rng.range(-0.5, 0.5);
        a.faceZ = cz + rng.range(-0.5, 0.5);
        this.agents.push(a);
      }
      this.crowdSpots.push(new THREE.Vector3(cx, 1.6, cz));
    }
  }

  setProcessionHead(z: number): void {
    this.processionZ = z;
  }

  // ---------------------------------------------------------------- simulation
  private gateNarrow(z: number): number {
    // half-width available inside the gate passages
    const zB = LAYOUT.rearGate.zFront - LAYOUT.rearGate.depth;
    const N = LAYOUT.northGate;
    if (z < 3 && z > zB - 2) return 1.75;
    if (z > N.z0 - 2 && z < N.z1 + 2) return 1.75;
    return 99;
  }

  update(dt: number, time: number, camera: THREE.PerspectiveCamera): void {
    const vx = camera.position.x,
      vz = camera.position.z,
      onGround = camera.position.y < 4.5;
    const rng = this.rng;
    const zMin = -330,
      zMax = 232;
    // procession advances; loops back to the north when it has entered the city
    this.processionZ -= this.processionSpeed * dt;
    if (this.processionZ < zMin) this.processionZ = zMax;
    const pz = this.processionZ;
    this.processionPos.set(0, 1.6, pz + 8);
    let censerIdx = 0;

    for (const a of this.agents) {
      a.active = true;
      let targetSpeed = 0;
      let headingTarget = a.heading;
      switch (a.role) {
        case 'procession': {
          const tz = pz + (a.fdz ?? 0);
          let tz2 = tz;
          if (tz2 > zMax + 50) tz2 -= zMax - zMin;
          const lim = this.gateNarrow(tz2);
          const dx = clamp(a.fdx ?? 0, -lim, lim) * (lim < 50 ? 0.9 : 1);
          a.x += (dx - a.x) * dampFactor(1.5, dt);
          const prevZ = a.z;
          a.z = tz2;
          targetSpeed = Math.abs(prevZ - a.z) > 5 ? this.processionSpeed : this.processionSpeed;
          headingTarget = Math.PI;
          a.active = a.z > zMin - 5 && a.z < zMax + 20;
          if (a.key === 'priest' && censerIdx < this.censers.length) {
            // the censer bowl hangs in front of the right hand (walk_censer clip)
            const c = this.censers[censerIdx++];
            const sinH = Math.sin(a.heading),
              cosH = Math.cos(a.heading);
            const lx = -0.18,
              lz = 0.37;
            c.set(a.x + lx * cosH + lz * sinH, 0.9, a.z - lx * sinH + lz * cosH);
          }
          break;
        }
        case 'walker': {
          const dir = a.dir ?? 1;
          // make way: wait at the side when the procession is in the same gate
          const lim = this.gateNarrow(a.z + dir * 6);
          const procNear = Math.abs(a.z - (pz + 20)) < 32 && lim < 50;
          targetSpeed = procNear ? 0 : a.baseSpeed;
          a.z += dir * a.speed * dt;
          let lane = a.laneX ?? 0;
          // people ahead of the (cinematic) camera drift to the wall side or the
          // procession side of their lane, whichever is further from the lens
          if (this.cameraClearance > 0 && onGround && Math.abs(a.z - vz) < 18 && Math.sign(lane) === Math.sign(vx) && Math.abs(lane - vx) < this.cameraClearance) {
            const toWall = Math.sign(lane) * (LAYOUT.road.halfWidth - 0.9);
            const toMid = Math.sign(lane) * 3.2;
            lane = Math.abs(toWall - vx) > Math.abs(toMid - vx) ? toWall : toMid;
          }
          const lx = clamp(lane, -lim, lim);
          a.x += (lx - a.x) * dampFactor(1.2, dt);
          headingTarget = dir > 0 ? 0 : Math.PI;
          // wrap around far away from the camera
          if (a.z > zMax || a.z < zMin) {
            a.z = dir > 0 ? zMin + rng.range(0, 10) : zMax - rng.range(0, 10);
            a.x = a.laneX ?? 0;
          }
          break;
        }
        case 'sentry': {
          const dir = a.dir ?? 1;
          targetSpeed = a.baseSpeed;
          a.z += dir * a.speed * dt;
          if (Math.abs(a.z - (a.homeZ ?? 0)) > (a.range ?? 6)) {
            a.dir = -dir;
            a.z = (a.homeZ ?? 0) + Math.sign(a.z - (a.homeZ ?? 0)) * (a.range ?? 6);
          }
          headingTarget = (a.dir ?? 1) > 0 ? 0 : Math.PI;
          break;
        }
        default: {
          // spectators, guards, plaza folk: stand, look at their focus; spectators
          // turn towards the procession as it passes and some gesture
          let fx = a.faceX ?? a.x,
            fz = a.faceZ ?? a.z + 1;
          if (a.role === 'spectator') {
            const d = Math.abs(a.z - (pz + 15));
            if (d < 26) {
              fx = 0;
              fz = pz + 15;
              if (a.canWave) a.gesture = Math.max(a.gesture, smoothstep(26, 10, d));
            }
          }
          headingTarget = Math.atan2(fx - a.x, fz - a.z);
          targetSpeed = 0;
          break;
        }
      }
      // make room for the viewer
      if (onGround && a.y < 1) {
        const ddx = a.x - vx,
          ddz = a.z - vz;
        const d = Math.hypot(ddx, ddz);
        const R = a.role === 'procession' ? 1.6 : 2.4;
        if (d < R && d > 1e-3) {
          const push = (R - d) * dampFactor(4, dt) * (a.role === 'procession' ? 0.6 : 1);
          a.x += (ddx / d) * push;
          if (a.role !== 'procession') a.z += (ddz / d) * push * 0.5;
        }
      }
      a.speed += (targetSpeed - a.speed) * dampFactor(3, dt);
      let dh = headingTarget - a.heading;
      dh = ((dh + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      a.heading += dh * dampFactor(a.role === 'procession' ? 2 : 3, dt);
      a.walk += ((a.speed > 0.08 ? 1 : 0) - a.walk) * dampFactor(4, dt);
      // clip phases: the gait cycle advances with the distance walked (no foot sliding)
      const clips = this.people.clips[a.type];
      const wc = clips[a.walkClip];
      if (wc) a.phaseW = (a.phaseW + (dt * (a.speed / Math.max(wc.speed, 0.1))) / wc.duration) % 1;
      const ic = clips[a.gesture > 0.5 ? 'wave' : a.idleClip];
      if (ic) a.phaseI = (a.phaseI + dt / ic.duration) % 1;
      a.gesture *= 1 - dampFactor(0.15, dt);
    }

    // palanquin follows its slot (dz 17.4 behind the head)
    const lz = pz + 17.4;
    this.palanquin.position.set(0, 0, lz);
    this.palanquin.rotation.y = Math.PI;
    this.palanquin.visible = lz > zMin && lz < zMax;
    this.palanquin.position.y = Math.abs(Math.sin(time * 2.4)) * 0.03;

    this.render(camera);
  }

  // ---------------------------------------------------------------- drawing
  private render(camera: THREE.PerspectiveCamera): void {
    this.cam.copy(camera.position);
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    for (const lods of this.meshes) for (const m of lods) m.count = 0;
    for (const pm of this.propMeshes.values()) pm.im.count = 0;
    for (const sp of this.shadowProxies) sp.im.count = 0;
    const frac = this.fraction;
    let idx = 0;
    for (const a of this.agents) {
      idx++;
      if (!a.active) continue;
      if (frac < 1 && a.role !== 'procession' && a.role !== 'guard' && (idx * 0.618) % 1 > frac) continue;
      const dx = a.x - this.cam.x,
        dz = a.z - this.cam.z,
        dy = a.y - this.cam.y;
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
      if (d > this.maxDistance) continue;
      const clips = this.people.clips[a.type];
      const idle: ClipInfo | undefined = clips[a.gesture > 0.5 ? 'wave' : a.idleClip] ?? clips.idle;
      const walk: ClipInfo | undefined = clips[a.walkClip] ?? clips.walk;
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, a.heading);
      this.m.compose(this.pV.set(a.x, a.y, a.z), this.q, this.sV.setScalar(a.scale));
      if (d < this.shadowDistance) {
        const sp = this.shadowProxies[a.vis];
        const j = sp.im.count++;
        sp.im.setMatrixAt(j, this.m);
        sp.at.iAnimA.setXYZW(j, idle.row, idle.frames, a.phaseI, a.walk);
        sp.at.iAnimB.setXYZW(j, walk.row, walk.frames, a.phaseW, 2 * a.id);
      }
      this.sphere.center.set(a.x, a.y + 1, a.z);
      this.sphere.radius = 1.9;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const lods = this.meshes[a.vis];
      const lod = Math.min(lods.length - 1, d < this.nearDistance ? 0 : d < this.midDistance ? 1 : d < this.farDistance ? 2 : 3);
      const im = this.meshes[a.vis][lod];
      const at = this.attrs[a.vis][lod];
      const i = im.count++;
      im.setMatrixAt(i, this.m);
      // A = idle / gesture, B = gait; blend by walking weight; w: smooth frame interpolation
      const smoothF = lod < 2 ? 1 : 0;
      void lods;
      const wTag = smoothF + 2 * a.id;
      at.iAnimA.setXYZW(i, idle.row, idle.frames, a.phaseI, a.walk);
      at.iAnimB.setXYZW(i, walk.row, walk.frames, a.phaseW, wTag);
      if (d < 90)
        for (const pk of a.props) {
          const pm = this.propMeshes.get(pk);
          if (!pm) continue;
          const j = pm.im.count++;
          pm.im.setMatrixAt(j, this.m);
          pm.at.iAnimA.setXYZW(j, idle.row, idle.frames, a.phaseI, a.walk);
          pm.at.iAnimB.setXYZW(j, walk.row, walk.frames, a.phaseW, wTag);
        }
    }
    const flush = (im: THREE.InstancedMesh, attrs: Record<string, THREE.InstancedBufferAttribute>) => {
      if (im.count === 0) return;
      for (const at of [im.instanceMatrix, ...Object.values(attrs)]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, im.count * at.itemSize);
        at.needsUpdate = true;
      }
    };
    for (const sp of this.shadowProxies) flush(sp.im, sp.at);
    for (const pm of this.propMeshes.values()) flush(pm.im, pm.at);
    for (let k = 0; k < this.meshes.length; k++) for (let l = 0; l < this.meshes[k].length; l++) flush(this.meshes[k][l], this.attrs[k][l]);
  }

  // ---------------------------------------------------------------- palanquin
  private buildPalanquin(): void {
    const g = this.palanquin;
    const wood = this.mats.wood;
    const col = (hex: number, rough: number, metal = 0) => new THREE.MeshStandardMaterial({ color: new THREE.Color().setHex(hex, THREE.SRGBColorSpace), roughness: rough, metalness: metal });
    // embossed gold sheet over cedar, lapis inlays in gold frames, a woven red canopy
    const gs = goldSheet();
    const gold = new THREE.MeshStandardMaterial({ map: gs.map, normalMap: gs.normalMap, roughnessMap: gs.roughnessMap, metalness: 1, roughness: 1 });
    gold.normalScale.setScalar(0.7);
    const cs = canopyCloth();
    const cloth = new THREE.MeshStandardMaterial({ map: cs.map, normalMap: cs.normalMap, roughnessMap: cs.roughnessMap, roughness: 1, metalness: 0, side: THREE.DoubleSide });
    const lapisMat = (aspect: number, n: number) => {
      const t = lapisPanel(aspect, n);
      const mm = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0 });
      mm.normalScale.setScalar(0.8);
      return mm;
    };
    const lapisLong = lapisMat(1.3 / 0.56, 3);
    const lapisEnd = lapisMat(0.9 / 0.56, 2);
    const purple = col(0x4a1638, 0.8);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      if (mat === gold) geo = applyWorldUV(geo, 0.4);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    // carrying poles of cedar with gilded finials
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.05, 0.05, 5.4, 10).rotateX(Math.PI / 2), wood, s * 0.72, 1.43, 0);
      for (const e of [-1, 1]) add(new THREE.SphereGeometry(0.075, 10, 8), gold, s * 0.72, 1.43, e * 2.72);
    }
    // platform with a gilded rim
    add(new THREE.BoxGeometry(1.56, 0.12, 2.5), wood, 0, 1.53, 0);
    add(new THREE.BoxGeometry(1.62, 0.05, 2.56), gold, 0, 1.6, 0);
    // gilded shrine with lapis-blue panels and a stepped cornice
    add(new THREE.BoxGeometry(1.2, 0.86, 1.62), gold, 0, 2.06, 0);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.02, 0.56, 1.3), lapisLong, s * 0.605, 2.06, 0);
      add(new THREE.BoxGeometry(0.9, 0.56, 0.02), lapisEnd, 0, 2.06, s * 0.815);
    }
    add(new THREE.BoxGeometry(1.3, 0.07, 1.72), gold, 0, 2.52, 0);
    add(new THREE.BoxGeometry(1.1, 0.06, 1.5), gold, 0, 2.58, 0);
    // the god's statue: robed in purple wool with gold appliqués, horned crown
    const robe = new THREE.LatheGeometry([
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.33, 0.0),
      new THREE.Vector2(0.3, 0.35),
      new THREE.Vector2(0.24, 0.8),
      new THREE.Vector2(0.21, 1.05),
      new THREE.Vector2(0.17, 1.15),
      new THREE.Vector2(0.0, 1.16),
    ], 18);
    add(robe, purple, 0, 2.61, 0.1);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 * 3.3;
      const y = 2.7 + (i / 26) * 0.95;
      const r = 0.31 - (i / 26) * 0.11;
      add(new THREE.SphereGeometry(0.018, 5, 4), gold, Math.cos(a) * r, y, 0.1 + Math.sin(a) * r);
    }
    add(new THREE.SphereGeometry(0.12, 14, 12), gold, 0, 3.9, 0.12);
    add(new THREE.ConeGeometry(0.1, 0.24, 10).rotateX(Math.PI), gold, 0, 3.74, 0.2);
    const crown = add(new THREE.CylinderGeometry(0.12, 0.13, 0.26, 14, 1, true), gold, 0, 4.12, 0.12);
    crown.material = gold;
    for (let k = 0; k < 3; k++) add(new THREE.TorusGeometry(0.128, 0.012, 6, 16).rotateX(Math.PI / 2), gold, 0, 4.02 + k * 0.08, 0.12);
    add(new THREE.SphereGeometry(0.06, 8, 6), gold, 0, 4.28, 0.12);
    // red canopy on gilded posts, gold fringe and tassels
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.CylinderGeometry(0.028, 0.032, 2.15, 8), gold, sx * 0.64, 3.68, sz * 0.88);
    const canopy = new THREE.PlaneGeometry(1.7, 2.2, 8, 8).rotateX(-Math.PI / 2);
    const pos = canopy.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, 0.14 * Math.cos((pos.getX(i) / 1.7) * Math.PI) * Math.cos((pos.getZ(i) / 2.2) * Math.PI));
    canopy.computeVertexNormals();
    add(canopy, cloth, 0, 4.76, 0);
    for (const [w, d, x, z] of [
      [1.72, 0.03, 0, 1.1],
      [1.72, 0.03, 0, -1.1],
      [0.03, 2.22, 0.86, 0],
      [0.03, 2.22, -0.86, 0],
    ]) {
      add(new THREE.BoxGeometry(w, 0.2, d), cloth, x, 4.66, z);
      add(new THREE.BoxGeometry(w + 0.01, 0.035, d + 0.01), gold, x, 4.56, z);
    }
    for (let i = 0; i < 28; i++) {
      const t = i / 28;
      const per = 2 * (1.7 + 2.2);
      let s = t * per;
      let x = 0,
        z = 0;
      if (s < 1.7) {
        x = -0.85 + s;
        z = 1.1;
      } else if ((s -= 1.7) < 2.2) {
        x = 0.85;
        z = 1.1 - s;
      } else if ((s -= 2.2) < 1.7) {
        x = 0.85 - s;
        z = -1.1;
      } else {
        s -= 1.7;
        x = -0.85;
        z = -1.1 + s;
      }
      add(new THREE.ConeGeometry(0.025, 0.12, 6).rotateX(Math.PI), gold, x, 4.49, z);
    }
    g.name = 'palanquin';
    void lerp;
  }

  get count(): number {
    return this.agents.length;
  }
}
