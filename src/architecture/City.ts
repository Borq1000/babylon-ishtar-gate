// The living city around the gate: courtyard-house districts (detailed near the
// viewer, instanced masses far away), the South Palace, the Ninmah temple, the
// North Palace and eastern outwork, Etemenanki and Esagila.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyWorldUV, boxAt, boxMinMax, GeometryBucket } from '../utils/geometry';
import { Random } from '../utils/math';
import { LAYOUT } from '../world/Layout';
import { addMerlons } from './ArchitectureKit';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import { patchMaterial } from '../materials/MaterialPatches';
import { VOLUME_LAYER } from '../rendering/VolumeShadow';
import type { Box2 } from './Monuments';

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface HouseSpec {
  x: number;
  z: number;
  w: number; // along the street
  d: number; // depth
  h: number;
  rot: number;
  tint: THREE.Color;
  street: boolean;
  wash: boolean;
}

const inside = (r: Rect, x: number, z: number, m = 0) => x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;

/** Colour palette of plastered mudbrick walls (multiplied with the plaster texture). */
const TINTS = [
  [1.32, 1.28, 1.2], // fresh gypsum whitewash
  [1.22, 1.16, 1.06],
  [1.08, 1.0, 0.88], // weathered wash
  [0.96, 0.86, 0.72], // bare mud plaster
  [0.9, 0.78, 0.62],
  [0.8, 0.68, 0.52], // darker, freshly re-plastered mud
  [1.0, 0.82, 0.66], // reddish clay plaster
  [0.86, 0.8, 0.7], // grey silt plaster
];

export class City {
  readonly group = new THREE.Group();
  readonly colliders: Box2[] = [];
  readonly palmSpots: { x: number; z: number; s: number }[] = [];
  readonly smokeSpots: THREE.Vector3[] = [];
  readonly lampSpots: THREE.Vector3[] = [];
  readonly roofs: { x: number; z: number; y: number }[] = [];
  private bucket = new GeometryBucket();
  // houses are merged per 160 m tile so shadow and frustum culling stay effective
  private colored = new Map<string, THREE.BufferGeometry[]>(); // mud-plastered houses
  private washed = new Map<string, THREE.BufferGeometry[]>(); // gypsum-washed houses
  private coloredVoid: THREE.BufferGeometry[] = [];
  private rng = new Random(575);
  private exclusions: Rect[] = [];

  constructor(private mats: MaterialLibrary) {
    this.group.name = 'city';
  }

  build(): void {
    const Cy = LAYOUT.city;
    const P = Cy.palace;
    this.exclusions = [
      { x0: -16, z0: -2000, x1: 16, z1: 400 }, // the Processional Way and its corridor
      { x0: -18, z0: -12, x1: 18, z1: 200 },
      { x0: -64, z0: -102, x1: 22, z1: -50 }, // plaza south of the gate
      { x0: P.x0 - 6, z0: P.z1 - 6, x1: P.x1 + 6, z1: P.z0 + 6 },
      { x0: Cy.ninmah.x - 34, z0: Cy.ninmah.z - 30, x1: Cy.ninmah.x + 34, z1: Cy.ninmah.z + 32 },
      { x0: Cy.ziggurat.x - 120, z0: Cy.ziggurat.z - 110, x1: Cy.ziggurat.x + 120, z1: Cy.ziggurat.z + 110 },
      { x0: Cy.esagila.x - 70, z0: Cy.esagila.z - 70, x1: Cy.esagila.x + 70, z1: Cy.esagila.z + 70 },
      { x0: Cy.euphratesX - 70, z0: -5000, x1: 6000, z1: 5000 }, // river and west bank
      { x0: -6000, z0: -36, x1: 6000, z1: -5 }, // the double wall and its zone
      { x0: -6000, z0: LAYOUT.moat.z0 - 6, x1: 6000, z1: LAYOUT.moat.z1 + 6 },
      { x0: 16, z0: -5, x1: 230, z1: 175 }, // North Palace
      { x0: -150, z0: -5, x1: -16, z1: 175 }, // eastern outwork
    ];

    this.buildSouthPalace();
    this.buildNorthPalace();
    this.buildOutwork();
    this.buildNinmah();
    this.buildEtemenanki();
    this.buildEsagila();

    // inner city districts (grid ~ aligned with the street; slightly rotated further out)
    const near: HouseSpec[] = [];
    const far: HouseSpec[] = [];
    this.district({ x0: -470, z0: -1500, x1: -16, z1: -40 }, 0, near, far, 520);
    this.district({ x0: 16, z0: -1500, x1: Cy.euphratesX - 72, z1: -336 }, 0, near, far, 520);
    // outer city north of the moat and beyond the outworks
    this.district({ x0: -1400, z0: 300, x1: Cy.euphratesX - 72, z1: 1600 }, -0.12, near, far, 0);
    this.district({ x0: -1400, z0: -5, x1: -160, z1: 210 }, 0, near, far, 0);
    this.district({ x0: -2600, z0: -2200, x1: -480, z1: -40 }, 0.27, near, far, 0);
    // west bank
    this.district({ x0: Cy.euphratesX + 120, z0: -1800, x1: 1500, z1: 1200 }, 0.1, near, far, 0);

    for (const h of near) this.house(h);
    this.buildFarHouses(far);
    this.flush();
  }

  // -------------------------------------------------------------- districts
  private district(r: Rect, rot: number, near: HouseSpec[], far: HouseSpec[], detailRadius: number): void {
    const rng = this.rng;
    const cos = Math.cos(rot),
      sin = Math.sin(rot);
    const cx = (r.x0 + r.x1) / 2,
      cz = (r.z0 + r.z1) / 2;
    const half = Math.hypot(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const toWorld = (u: number, v: number) => ({ x: cx + u * cos - v * sin, z: cz + u * sin + v * cos });
    let v = -half;
    while (v < half) {
      const blockD = rng.range(34, 58);
      let u = -half;
      while (u < half) {
        const blockW = rng.range(40, 76);
        // houses along the four sides of the block, courtyards/gardens inside
        const depth = rng.range(9, 13);
        const sides: [number, number, number, number, number][] = [
          // [u0, v0, length, dir(0:+u,1:+v), facing]
          [u, v, blockW, 0, -1],
          [u, v + blockD - depth, blockW, 0, 1],
        ];
        for (const [su, sv, len] of sides) {
          let a = 0;
          while (a < len - 4) {
            const w = Math.min(len - a, rng.range(7, 15));
            const hu = su + a + w / 2;
            const hv = sv + depth / 2;
            const p = toWorld(hu, hv);
            a += w + rng.range(0, 0.6);
            if (!inside(r, p.x, p.z)) continue;
            if (this.exclusions.some((e) => inside(e, p.x, p.z, 4))) continue;
            if (rng.chance(0.07)) continue; // empty lot / garden
            const dist = Math.hypot(p.x, p.z + 60);
            const t = rng.pick(TINTS);
            const spec: HouseSpec = {
              x: p.x,
              z: p.z,
              w: w - 0.3,
              d: depth * rng.range(0.85, 1.0),
              h: rng.chance(0.25) ? rng.range(6.5, 9) : rng.range(3.6, 5.6),
              rot: rot + (sv > v ? Math.PI : 0),
              tint: new THREE.Color(t[0], t[1], t[2]).multiplyScalar(rng.range(0.94, 1.04)),
              street: true,
              wash: rng.chance(0.42),
            };
            if (dist < detailRadius) near.push(spec);
            else far.push(spec);
          }
        }
        // end walls of the block (short sides) as plain long houses
        for (const su2 of [u, u + blockW - depth]) {
          const p = toWorld(su2 + depth / 2, v + blockD / 2);
          if (!inside(r, p.x, p.z) || this.exclusions.some((e) => inside(e, p.x, p.z, 4))) continue;
          const dist = Math.hypot(p.x, p.z + 60);
          const t = rng.pick(TINTS);
          const spec: HouseSpec = {
            x: p.x,
            z: p.z,
            w: blockD - 2 * depth - 0.6,
            d: depth,
            h: rng.range(3.6, 5.4),
            rot: rot + Math.PI / 2,
            tint: new THREE.Color(t[0], t[1], t[2]),
            street: false,
            wash: rng.chance(0.42),
          };
          if (spec.w > 3) (dist < detailRadius ? near : far).push(spec);
        }
        // courtyard garden palms
        const gp = toWorld(u + blockW / 2 + rng.range(-8, 8), v + blockD / 2 + rng.range(-5, 5));
        if (rng.chance(0.55) && inside(r, gp.x, gp.z) && !this.exclusions.some((e) => inside(e, gp.x, gp.z, 6)))
          this.palmSpots.push({ x: gp.x, z: gp.z, s: rng.range(0.75, 1.05) });
        if (rng.chance(0.06)) {
          const sp = toWorld(u + rng.range(8, blockW - 8), v + rng.range(2, 8));
          if (!this.exclusions.some((e) => inside(e, sp.x, sp.z, 4))) this.smokeSpots.push(new THREE.Vector3(sp.x, 6, sp.z));
        }
        u += blockW + rng.range(4.5, 7.5);
      }
      v += blockD + rng.range(4.5, 7.5);
    }
  }

  /** Detailed courtyard-house street front. */
  private house(h: HouseSpec): void {
    const rng = this.rng;
    const parts: THREE.BufferGeometry[] = [];
    const voids: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4().makeRotationY(h.rot).setPosition(h.x, 0, h.z);
    const add = (g: THREE.BufferGeometry, list = parts) => {
      g.applyMatrix4(m);
      list.push(g);
    };
    // body
    add(boxAt(h.w, h.h, h.d, 0, 0, 0));
    // parapet
    const pt = 0.25,
      ph = 0.55;
    add(boxAt(h.w, ph, pt, 0, h.h, -h.d / 2 + pt / 2));
    add(boxAt(h.w, ph, pt, 0, h.h, h.d / 2 - pt / 2));
    add(boxAt(pt, ph, h.d, -h.w / 2 + pt / 2, h.h, 0));
    add(boxAt(pt, ph, h.d, h.w / 2 - pt / 2, h.h, 0));
    // roof room
    if (rng.chance(0.35) && h.w > 6) {
      const rw = rng.range(2.6, 3.8);
      const side = rng.chance(0.5) ? -1 : 1;
      add(boxAt(rw, 2.3, rw, side * (h.w / 2 - rw / 2 - 0.3), h.h, rng.range(-1, 1)));
    }
    // street face (local -z): door, a high window or two, beam ends
    const fz = -h.d / 2 - 0.015;
    if (h.street) {
      const dx = rng.range(-h.w / 2 + 1.2, h.w / 2 - 1.2);
      add(boxAt(1.0, 2.05, 0.05, dx, 0, fz), voids);
      if (rng.chance(0.6)) add(boxAt(0.45, 0.5, 0.05, rng.range(-h.w / 2 + 0.8, h.w / 2 - 0.8), h.h - 1.4, fz), voids);
      if (h.h > 6) add(boxAt(0.45, 0.55, 0.05, rng.range(-h.w / 2 + 0.8, h.w / 2 - 0.8), h.h - 2.3, fz), voids);
      // palm-log beam ends below the roof (only on houses near the viewer)
      if (Math.hypot(h.x, h.z + 60) < 260)
        for (let bx = -h.w / 2 + 0.6; bx < h.w / 2 - 0.4; bx += 0.85) {
          const g = new THREE.BoxGeometry(0.16, 0.16, 0.34);
          g.translate(bx, h.h - 0.35, -h.d / 2 - 0.12);
          g.applyMatrix4(m);
          this.bucket.add('beams', g);
        }
      if (rng.chance(0.08)) this.smokeSpots.push(new THREE.Vector3(h.x, h.h + 0.6, h.z));
    }
    this.roofs.push({ x: h.x, z: h.z, y: h.h });
    // vertex colours carry the wash tint
    for (const g of parts) {
      const geo = applyWorldUV(g, 2);
      const n = geo.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      const k = h.wash ? 0.74 : 1;
      for (let i = 0; i < n; i++) col.set([h.tint.r * k, h.tint.g * k, h.tint.b * k], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const tile = Math.floor(h.x / 160) + ',' + Math.floor(h.z / 160);
      const map = h.wash ? this.washed : this.colored;
      if (!map.has(tile)) map.set(tile, []);
      map.get(tile)!.push(geo);
    }
    for (const g of voids) this.coloredVoid.push(g.index ? g.toNonIndexed() : g);
    if (Math.hypot(h.x, h.z) < 700) {
      const r = Math.max(h.w, h.d) / 2;
      this.colliders.push({ x0: h.x - r, z0: h.z - r, x1: h.x + r, z1: h.z + r });
    }
  }

  /** Distant houses: one instanced box mesh with per-instance tint. */
  private buildFarHouses(all: HouseSpec[]): void {
    // beyond ~2.6 km the haze swallows everything anyway
    const list = all.filter((h) => Math.hypot(h.x, h.z + 200) < 2600);
    if (!list.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    patchMaterial(mat, {
      weathering: { macro: this.mats.macro, macroScale: 0.03, macroStrength: 0.8, dustHeight: 1.0, dustStrength: 0.4, topDust: 0.4, streaks: 0.12, roof: 0.85 },
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const base = new THREE.Color().setHex(0xb59a76, THREE.SRGBColorSpace);
    list.forEach((h, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.rot);
      m.compose(p.set(h.x, 0, h.z), q, s.set(h.w, h.h + 0.5, h.d));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, base.clone().multiply(h.tint));
    });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'city:farHouses';
    this.group.add(mesh);
  }

  // -------------------------------------------------------------- landmarks
  private niched(key: string, x0: number, z0: number, x1: number, z1: number, h: number, step = 4.2, depth = 0.45): void {
    // a wall mass with the vertical recesses and buttresses of Mesopotamian façades
    this.bucket.add(key, applyWorldUV(boxMinMax(x0 + depth, 0, z0 + depth, x1 - depth, h, z1 - depth), 2));
    const lenX = x1 - x0,
      lenZ = z1 - z0;
    for (let a = step * 0.25; a < lenX - 0.5; a += step) {
      const w = Math.min(step * 0.55, lenX - a);
      this.bucket.add(key, applyWorldUV(boxMinMax(x0 + a, 0, z0, x0 + a + w, h, z0 + depth), 2));
      this.bucket.add(key, applyWorldUV(boxMinMax(x0 + a, 0, z1 - depth, x0 + a + w, h, z1), 2));
    }
    for (let a = step * 0.25; a < lenZ - 0.5; a += step) {
      const w = Math.min(step * 0.55, lenZ - a);
      this.bucket.add(key, applyWorldUV(boxMinMax(x0, 0, z0 + a, x0 + depth, h, z0 + a + w), 2));
      this.bucket.add(key, applyWorldUV(boxMinMax(x1 - depth, 0, z0 + a, x1, h, z0 + a + w), 2));
    }
  }

  private buildSouthPalace(): void {
    const P = LAYOUT.city.palace;
    const H = 17;
    const x0 = P.x0,
      x1 = P.x1,
      zN = P.z0,
      zS = P.z1;
    // outer walls as a ring of niched masses
    this.niched('buff', x0, zN - 6, x1, zN, H);
    this.niched('buff', x0, zS, x1, zS + 6, H);
    this.niched('buff', x0, zS, x0 + 6, zN, H);
    this.niched('buff', x1 - 6, zS, x1, zN, H);
    for (const [a, b, c, d] of [
      [x0, zN - 6, x1, zN],
      [x0, zS, x1, zS + 6],
      [x0, zS, x0 + 6, zN],
      [x1 - 6, zS, x1, zN],
    ])
      this.colliders.push({ x0: a, z0: b, x1: c, z1: d });
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0, 0, zN - 0.3), new THREE.Vector3(1, 0, 0), x1 - x0, H);
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0 + 0.3, 0, zS), new THREE.Vector3(0, 0, 1), zN - zS, H);
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x1 - 0.3, 0, zS), new THREE.Vector3(0, 0, 1), zN - zS, H);
    // towers along the east façade (facing the Processional Way) and north side
    for (let z = zN - 12; z > zS + 8; z -= 22) {
      this.bucket.add('buff', applyWorldUV(boxMinMax(x0 - 2.5, 0, z - 4, x0 + 6, H + 3, z + 4), 2));
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0 - 2.2, 0, z - 4), new THREE.Vector3(0, 0, 1), 8, H + 3, { spacing: 1.25 });
    }
    for (let x = x0 + 14; x < x1 - 8; x += 22) {
      this.bucket.add('buff', applyWorldUV(boxMinMax(x - 4, 0, zN - 6, x + 4, H + 3, zN + 2.5), 2));
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(x - 4, 0, zN + 2.2), new THREE.Vector3(1, 0, 0), 8, H + 3, { spacing: 1.25 });
    }
    // main gate on the east side, opening onto the plaza
    const gz = -112;
    this.bucket.add('buff', applyWorldUV(boxMinMax(x0 - 6, 0, gz - 14, x0 + 8, H + 6, gz - 3), 2));
    this.bucket.add('buff', applyWorldUV(boxMinMax(x0 - 6, 0, gz + 3, x0 + 8, H + 6, gz + 14), 2));
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0 - 5.7, 0, gz - 14), new THREE.Vector3(0, 0, 1), 11, H + 6, { spacing: 1.2 });
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0 - 5.7, 0, gz + 3), new THREE.Vector3(0, 0, 1), 11, H + 6, { spacing: 1.2 });
    this.bucket.add('void', boxMinMax(x0 - 0.2, 0, gz - 2.2, x0 + 0.2, 7.5, gz + 2.2));
    // interior: courts and halls rising above the walls (seen from above)
    this.courts(x0 + 8, zS + 8, x1 - 8, zN - 8, 9, 18);
    // throne room block with a blue-glazed façade band
    this.bucket.add('buff', applyWorldUV(boxMinMax(x0 + 70, 0, -190, x0 + 125, 22, -168), 2));
    this.bucket.add('glazed', applyWorldUV(boxMinMax(x0 + 70, 13, -168.4, x0 + 125, 20, -168), 2));
    this.lampSpots.push(new THREE.Vector3(x0 - 3, 1.2, gz - 6), new THREE.Vector3(x0 - 3, 1.2, gz + 6));
  }

  /** Interior of a walled complex: courts ringed by building wings of varied height. */
  private courts(x0: number, z0: number, x1: number, z1: number, hMin: number, hMax: number): void {
    const rng = this.rng;
    let z = z0;
    while (z < z1 - 12) {
      const cd = Math.min(z1 - z, rng.range(34, 56));
      let x = x0;
      while (x < x1 - 12) {
        const cw = Math.min(x1 - x, rng.range(36, 62));
        const wing = rng.range(7, 11);
        const h = rng.range(hMin, hMax);
        const key = rng.chance(0.65) ? 'buff' : 'plasterLight';
        if (rng.chance(0.2)) {
          this.bucket.add(key, applyWorldUV(boxMinMax(x + 1, 0, z + 1, x + cw - 1, h * 1.15, z + cd - 1), 2));
          addMerlons(this.bucket, key === 'buff' ? 'glazed' : 'plasterLight', new THREE.Vector3(x + 1, 0, z + cd - 1.3), new THREE.Vector3(1, 0, 0), cw - 2, h * 1.15, { spacing: 1.4 });
        } else {
          // four wings around an open court
          this.bucket.add(key, applyWorldUV(boxMinMax(x + 1, 0, z + 1, x + cw - 1, h, z + 1 + wing), 2));
          this.bucket.add(key, applyWorldUV(boxMinMax(x + 1, 0, z + cd - 1 - wing, x + cw - 1, h, z + cd - 1), 2));
          this.bucket.add(key, applyWorldUV(boxMinMax(x + 1, 0, z + 1 + wing, x + 1 + wing, h * 0.9, z + cd - 1 - wing), 2));
          this.bucket.add(key, applyWorldUV(boxMinMax(x + cw - 1 - wing, 0, z + 1 + wing, x + cw - 1, h * 0.9, z + cd - 1 - wing), 2));
          // brick-paved court floor
          this.bucket.add('courtFloor', applyWorldUV(boxMinMax(x + 1 + wing, -0.2, z + 1 + wing, x + cw - 1 - wing, 0.03, z + cd - 1 - wing), 2));
          if (rng.chance(0.5)) this.palmSpots.push({ x: x + cw / 2 + rng.range(-3, 3), z: z + cd / 2 + rng.range(-3, 3), s: rng.range(0.8, 1.0) });
          if (rng.chance(0.15)) this.smokeSpots.push(new THREE.Vector3(x + cw / 2, h + 0.5, z + wing / 2));
        }
        x += cw;
      }
      z += cd;
    }
  }

  private buildNorthPalace(): void {
    const x0 = 18 + 7,
      x1 = 225,
      z0 = 4,
      z1 = 170;
    const t = 6,
      H = 14;
    this.niched('buff', x0, z0, x1, z0 + t, H, 4.4, 0.4);
    this.niched('buff', x0, z1 - t, x1, z1, H, 4.4, 0.4);
    this.niched('buff', x0, z0, x0 + t, z1, H, 4.4, 0.4);
    this.niched('buff', x1 - t, z0, x1, z1, H, 4.4, 0.4);
    this.colliders.push({ x0, z0, x1, z1 });
    this.courts(x0 + t + 2, z0 + t + 2, x1 - t - 2, z1 - t - 2, 8, 15);
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x0, 0, z1 - 0.3), new THREE.Vector3(1, 0, 0), x1 - x0, H);
    addMerlons(this.bucket, 'buff', new THREE.Vector3(x1 - 0.3, 0, z0), new THREE.Vector3(0, 0, 1), z1 - z0, H);
    addMerlons(this.bucket, 'buff', new THREE.Vector3(x0, 0, z0 + 0.3), new THREE.Vector3(1, 0, 0), x1 - x0, H);
  }

  private buildOutwork(): void {
    const x0 = -150,
      x1 = -18 - 7,
      z0 = 4,
      z1 = 170;
    const t = 7,
      H = 12;
    this.niched('buff', x0, z0, x1, z0 + t, H, 5, 0.5);
    this.niched('buff', x0, z1 - t, x1, z1, H, 5, 0.5);
    this.niched('buff', x0, z0, x0 + t, z1, H, 5, 0.5);
    this.colliders.push({ x0, z0, x1, z1 });
    for (let z = z0 + 10; z < z1; z += 20) {
      this.bucket.add('buff', applyWorldUV(boxMinMax(x0 - 3, 0, z - 4, x0 + 6, 15, z + 4), 2));
      addMerlons(this.bucket, 'buff', new THREE.Vector3(x0 - 2.7, 0, z - 4), new THREE.Vector3(0, 0, 1), 8, 15, { spacing: 1.25 });
    }
    this.courts(x0 + t + 2, z0 + t + 2, x1 - 2, z1 - t - 2, 6, 10);
    addMerlons(this.bucket, 'buff', new THREE.Vector3(x0 + 0.3, 0, z0), new THREE.Vector3(0, 0, 1), z1 - z0, H);
    addMerlons(this.bucket, 'buff', new THREE.Vector3(x0, 0, z1 - 0.3), new THREE.Vector3(1, 0, 0), x1 - x0, H);
  }

  private buildNinmah(): void {
    // E-mah: whitewashed mudbrick with stepped vertical grooves; entrance faces north
    const { x, z } = LAYOUT.city.ninmah;
    const w = 53,
      d = 38,
      h = 9.5;
    this.niched('plasterLight', x - w / 2, z - d / 2, x + w / 2, z + d / 2, h, 2.4, 0.35);
    this.colliders.push({ x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2 });
    // entrance towers on the north façade
    for (const s of [-1, 1]) {
      this.bucket.add('plasterLight', applyWorldUV(boxMinMax(x + s * 2.4, 0, z + d / 2 - 2, x + s * 7.5, h + 3, z + d / 2 + 2.6), 2));
    }
    this.bucket.add('void', boxMinMax(x - 1.3, 0, z + d / 2 - 0.1, x + 1.3, 4.2, z + d / 2 + 0.05));
    addMerlons(this.bucket, 'plasterLight', new THREE.Vector3(x - w / 2, 0, z + d / 2 - 0.3), new THREE.Vector3(1, 0, 0), w, h, { spacing: 1.1, width: 0.8 });
    addMerlons(this.bucket, 'plasterLight', new THREE.Vector3(x - w / 2 + 0.3, 0, z - d / 2), new THREE.Vector3(0, 0, 1), d, h, { spacing: 1.1, width: 0.8 });
    addMerlons(this.bucket, 'plasterLight', new THREE.Vector3(x + w / 2 - 0.3, 0, z - d / 2), new THREE.Vector3(0, 0, 1), d, h, { spacing: 1.1, width: 0.8 });
    // small altar before the entrance
    this.bucket.add('plasterLight', applyWorldUV(boxMinMax(x - 1.2, 0, z + d / 2 + 7, x + 1.2, 1.2, z + d / 2 + 8.6), 2));
    this.lampSpots.push(new THREE.Vector3(x, 1.25, z + d / 2 + 7.8));
  }

  private buildEtemenanki(): void {
    // Terraces after Pedersén's reading of the Tower Stele (width × height, m)
    const { x, z } = LAYOUT.city.ziggurat;
    const terraces: [number, number][] = [
      [91.5, 28],
      [80.5, 9.5],
      [71.0, 8.8],
      [61.5, 8.8],
      [51.2, 8.8],
      [40.3, 8.1],
    ];
    let y = 0;
    terraces.forEach(([w, h], k) => {
      const hw = w / 2;
      this.bucket.add('buff', applyWorldUV(boxMinMax(x - hw + 0.6, y, z - hw + 0.6, x + hw - 0.6, y + h, z + hw - 0.6), 2));
      // The baked-brick mantle: deep full-height buttresses on the first stage; on
      // the upper stages pilasters carry a continuous top band, so that the wall
      // between them reads as a row of tall recessed niches (Pedersén's model).
      const step = k === 0 ? 4.6 : 4.2;
      const y0 = k === 0 ? y : y + h * 0.3;
      const pw = k === 0 ? 1.7 : 1.4;
      for (let a = -hw + 2; a < hw - 1; a += step) {
        for (const [px, pz, wx, wz] of [
          [x + a, z - hw - 0.4, pw, 1.0],
          [x + a, z + hw - 0.6, pw, 1.0],
          [x - hw - 0.4, z + a, 1.0, pw],
          [x + hw - 0.6, z + a, 1.0, pw],
        ])
          this.bucket.add('buff', applyWorldUV(boxMinMax(px, y0, pz, px + wx, y + h, pz + wz), 2));
      }
      if (k > 0) {
        const bh = Math.min(1.1, h * 0.14);
        for (const [x0, z0, x1, z1] of [
          [x - hw - 0.4, z - hw - 0.4, x + hw + 0.4, z - hw + 0.6],
          [x - hw - 0.4, z + hw - 0.6, x + hw + 0.4, z + hw + 0.4],
          [x - hw - 0.4, z - hw - 0.4, x - hw + 0.6, z + hw + 0.4],
          [x + hw - 0.6, z - hw - 0.4, x + hw + 0.4, z + hw + 0.4],
        ])
          this.bucket.add('buff', applyWorldUV(boxMinMax(x0, y + h - bh, z0, x1, y + h, z1), 2));
      }
      y += h;
    });
    // the blue-glazed temple on the summit, its walls articulated by deep recesses
    const tw = 28.5 / 2;
    this.bucket.add('glazed', applyWorldUV(boxMinMax(x - tw + 0.5, y, z - tw * 0.8 + 0.5, x + tw - 0.5, y + 15, z + tw * 0.8 - 0.5), 2));
    for (let a = -tw; a < tw - 0.5; a += 3.0)
      for (const [zz0, zz1] of [
        [z - tw * 0.8, z - tw * 0.8 + 0.6],
        [z + tw * 0.8 - 0.6, z + tw * 0.8],
      ])
        this.bucket.add('glazed', applyWorldUV(boxMinMax(x + a, y, zz0, x + a + 1.5, y + 15, zz1), 2));
    for (let a = -tw * 0.8; a < tw * 0.8 - 0.5; a += 3.0)
      for (const [xx0, xx1] of [
        [x - tw, x - tw + 0.6],
        [x + tw - 0.6, x + tw],
      ])
        this.bucket.add('glazed', applyWorldUV(boxMinMax(xx0, y, z + a, xx1, y + 15, z + a + 1.5), 2));
    this.bucket.add('glazed', applyWorldUV(boxMinMax(x - 5, y, z + tw * 0.8, x + 5, y + 17, z + tw * 0.8 + 2), 2));
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x - tw, 0, z + tw * 0.8 - 0.3), new THREE.Vector3(1, 0, 0), 2 * tw, y + 15, { spacing: 1.4, width: 1.1, height: 1.3 });
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x - tw, 0, z - tw * 0.8 + 0.3), new THREE.Vector3(1, 0, 0), 2 * tw, y + 15, { spacing: 1.4, width: 1.1, height: 1.3 });
    this.bucket.add('void', boxMinMax(x - 1.6, y, z + tw * 0.8 + 2.0, x + 1.6, y + 6, z + tw * 0.8 + 2.06));
    // the great southern stair (seen from the city)
    const stair = new THREE.BoxGeometry(9, 2, 70);
    stair.rotateX(-Math.atan2(37, 70));
    stair.translate(x, 18.5, z - 45.75 - 22);
    this.bucket.add('buff', applyWorldUV(stair, 2));
    this.anchors.zigguratTop = new THREE.Vector3(x, y + 15, z);
  }

  readonly anchors: Record<string, THREE.Vector3> = {};

  private buildEsagila(): void {
    const { x, z } = LAYOUT.city.esagila;
    this.niched('buff', x - 43, z - 40, x + 43, z + 40, 15, 4.4, 0.45);
    this.bucket.add('plasterLight', applyWorldUV(boxMinMax(x - 22, 0, z - 18, x + 22, 22, z + 18), 2));
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(x - 43, 0, z + 39.7), new THREE.Vector3(1, 0, 0), 86, 15);
    addMerlons(this.bucket, 'buff', new THREE.Vector3(x - 22, 0, z + 17.7), new THREE.Vector3(1, 0, 0), 44, 22);
    for (const s of [-1, 1]) this.bucket.add('buff', applyWorldUV(boxMinMax(x + 43 - 3, 0, z + s * 6, x + 47, 19, z + s * 14), 2));
  }

  // -------------------------------------------------------------- meshes
  private flush(): void {
    const m = this.mats;
    const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, name: string, shadow = true, volume = false) => {
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      if (volume) mesh.layers.enable(VOLUME_LAYER);
      this.group.add(mesh);
    };
    add(this.bucket.build('buff'), m.buff, 'city:buff', true, true);
    add(this.bucket.build('glazed'), m.glazed, 'city:glazed', true, true);
    add(this.bucket.build('plasterLight'), m.whitewash, 'city:whitewash', true, true);
    add(this.bucket.build('void'), m.voidMat, 'city:void', false);
    add(this.bucket.build('beams'), m.wood, 'city:beams', true);
    add(this.bucket.build('courtFloor'), m.brickPave, 'city:courts', false);
    const houseMat = (base: THREE.MeshStandardMaterial, tint: number | null, key: string) => {
      const mat = base.clone();
      mat.vertexColors = true;
      if (tint !== null) mat.color.setHex(tint);
      mat.onBeforeCompile = base.onBeforeCompile;
      mat.customProgramCacheKey = () => base.customProgramCacheKey() + key;
      return mat;
    };
    const mudMat = houseMat(m.plaster, null, '|vc');
    const washMat = houseMat(m.whitewash, 0xe9dfcb, '|vcw');
    for (const [map, mat, name] of [
      [this.colored, mudMat, 'city:houses'],
      [this.washed, washMat, 'city:washedHouses'],
    ] as [Map<string, THREE.BufferGeometry[]>, THREE.Material, string][]) {
      for (const [tile, list] of map) {
        const geo = mergeGeometries(list, false)!;
        geo.computeBoundingSphere();
        add(geo, mat, name + ':' + tile, true, true);
      }
    }
    if (this.coloredVoid.length) {
      const geo = mergeGeometries(this.coloredVoid.map((g) => {
        const gg = g.index ? g.toNonIndexed() : g;
        for (const k of Object.keys(gg.attributes)) if (k !== 'position' && k !== 'normal') gg.deleteAttribute(k);
        return gg;
      }), false)!;
      add(geo, m.voidMat, 'city:openings', false);
    }
  }
}
