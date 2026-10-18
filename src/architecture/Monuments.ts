// The monumental core: the Processional Way corridor with its lion frieze and
// street-side towers, the North Gate and moat bridge, the double Ishtar Gate
// (front gate, light-well, main gate), the city walls and the paving.
// Static geometry is merged per material; reliefs are instanced.

import * as THREE from 'three';
import { applyWorldUV, boxMinMax, GeometryBucket } from '../utils/geometry';
import { C, L, LAYOUT } from '../world/Layout';
import {
  addMerlons,
  addSlit,
  archedBlock,
  archPath,
  archRibbon,
  faceMatrix,
  facePoint,
  makeFace,
  stripGeometry,
  type WallFace,
  worldU,
} from './ArchitectureKit';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { ReliefLibrary, ReliefPanels } from './reliefs/ReliefLibrary';
import { VOLUME_LAYER } from '../rendering/VolumeShadow';
import { makeRecessMaterial } from '../materials/RecessMaterial';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Box2 {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ReliefKeys {
  lionA: string;
  lionB: string;
  bull: string;
  dragon: string;
}

const WORLD_TILES: Record<string, number> = { glazed: 2, buff: 2, limestone: 4.2, breccia: 2.1, brickPave: 2, wood: 1.5 };
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

export class Monuments {
  readonly group = new THREE.Group();
  readonly colliders: Box2[] = [];
  /** Named points used by cameras, emitters and lamps. */
  readonly anchors: Record<string, THREE.Vector3> = {};
  /** Positions for wall-mounted lamps / braziers. */
  readonly lampSpots: { pos: THREE.Vector3; kind: 'torch' | 'brazier' }[] = [];
  private bucket = new GeometryBucket();
  private slits: THREE.BufferGeometry[] = [];
  private readonly revealBuff = new THREE.Color().setHex(0xc9a978, THREE.SRGBColorSpace);
  private readonly revealGlazed = new THREE.Color().setHex(0x29478d, THREE.SRGBColorSpace);

  constructor(
    private mats: MaterialLibrary,
    private lib: ReliefLibrary,
    private panels: ReliefPanels,
    private keys: ReliefKeys,
  ) {
    this.group.name = 'monuments';
  }

  // ------------------------------------------------------------------ helpers
  private world(key: string, g: THREE.BufferGeometry): void {
    this.bucket.add(key, applyWorldUV(g, WORLD_TILES[key] ?? 2));
  }

  private solid(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, collide = true): void {
    this.world(key, boxMinMax(x0, y0, z0, x1, y1, z1));
    if (collide) this.collide(x0, z0, x1, z1);
  }

  private collide(x0: number, z0: number, x1: number, z1: number): void {
    this.colliders.push({ x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) });
  }

  private band(kind: string, f: WallFace, u0: number, u1: number, c0: number, c1: number): void {
    if (u1 - u0 < 0.01) return;
    this.bucket.add(`band:${kind}`, stripGeometry(f, u0, u1, c0 * C, c1 * C, 0.002, 2));
  }

  /** Turquoise lion register background (2 m tile → v spans height / 2). */
  private turq(f: WallFace, u0: number, u1: number, c0: number, c1: number): void {
    const g = stripGeometry(f, u0, u1, c0 * C, c1 * C, 0.0015, 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) * ((c1 - c0) * C)) / 2);
    this.bucket.add('turq', g);
  }

  /** Vertical frame strip: u across (0..1), v = y / 2 m. */
  private vborder(f: WallFace, u0: number, u1: number, y0: number, y1: number): void {
    const g = stripGeometry(f, u0, u1, y0, y1, 0.0025, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    const ua = worldU(facePoint(f, u0, 0), f.normal);
    for (let i = 0; i < uv.count; i++) {
      p.fromBufferAttribute(pos, i);
      uv.setXY(i, (worldU(p, f.normal) - ua) / (u1 - u0), p.y / 2);
    }
    this.bucket.add('band:vborder', g);
  }

  /** Snaps a face-u to the brick grid in world coordinates. */
  private snapU(f: WallFace, u: number): number {
    const off = worldU(f.origin, f.normal);
    return Math.round((u + off) / L) * L - off;
  }

  /**
   * Adds one relief panel whose left edge is at brick joint u. A mirrored panel
   * samples its texture back to front, which moves its running bond by half a
   * brick, so it is shifted by L/2 to keep every joint continuous with the wall.
   */
  private placePanel(asset: string, mirrored: boolean, f: WallFace, u: number, course: number): void {
    this.panels.add(asset, mirrored, faceMatrix(f, mirrored ? u - L / 2 : u, course * C, 0.004));
  }

  /** Places n relief panels evenly inside [a, b] on a face, snapped to brick joints. */
  private panelRow(asset: string, mirrored: boolean, f: WallFace, a: number, b: number, n: number, course: number): void {
    const info = this.lib.assets.get(asset);
    if (!info) return;
    const w = info.maps.panelW;
    const gap = (b - a - n * w) / (n + 1);
    for (let i = 0; i < n; i++) {
      const u = this.snapU(f, a + gap * (i + 1) + w * i);
      this.placePanel(asset, mirrored, f, u, course);
    }
  }

  // ------------------------------------------------------------------ build
  build(): void {
    this.buildPaving();
    this.buildProcessionalWay();
    this.buildNorthGate();
    this.buildFrontGate();
    this.buildLightWell();
    this.buildMainGate();
    this.buildCityWalls();
    this.flush();
  }

  private buildPaving(): void {
    const r = LAYOUT.road;
    const zN = 330,
      zS = -480;
    this.world('limestone', boxMinMax(-r.limeHalfWidth, -0.3, zS, r.limeHalfWidth, 0.02, zN));
    for (const s of [-1, 1]) {
      this.world('breccia', boxMinMax(s * r.limeHalfWidth, -0.3, zS, s * r.brecciaHalfWidth, 0.016, zN));
      this.world('brickPave', boxMinMax(s * r.brecciaHalfWidth, -0.3, zS, s * (r.halfWidth + 0.01), 0.01, zN));
    }
  }

  /** One lion-frieze segment (bands + lions) on a street-facing face. */
  private friezeSegment(f: WallFace, uA: number, uB: number, lionIndex: number, nLions: number, side: number): void {
    this.band('checker', f, uA, uB, 6, 8);
    this.band('rosette', f, uA, uB, 8, 12);
    this.band('checker', f, uA, uB, 12, 14);
    this.turq(f, uA, uB, 14, 26);
    this.band('checker', f, uA, uB, 26, 28);
    this.band('rosette', f, uA, uB, 28, 32);
    this.band('yellow', f, uA, uB, 32, 33);
    const spacing = LAYOUT.procWall.lionSpacingBricks * L;
    for (let i = 0; i < nLions; i++) {
      const asset = (lionIndex + i) % 2 === 0 ? this.keys.lionA : this.keys.lionB;
      const a = this.lib.assets.get(asset)!;
      const u = this.snapU(f, uA + (spacing - a.maps.panelW) / 2 + i * spacing);
      // Lions stride NORTH, towards people arriving (Berlin / Pedersén reconstruction):
      // east wall (dirU = south) uses the mirrored panel, west wall (dirU = north) the normal one.
      this.placePanel(asset, side < 0, f, u, 14);
    }
  }

  private buildProcessionalWay(): void {
    const P = LAYOUT.procWall;
    const R = LAYOUT.road;
    const zS = LAYOUT.outerWall.zNorth,
      zN = R.zEnd;
    const hc = Math.round(P.height / C);
    const tc = Math.round(P.towerHeight / C);
    const seg = P.towerWidth;
    let lion = 0;
    for (const s of [-1, 1]) {
      const xi = s * R.halfWidth; // curtain face
      const xt = s * (R.halfWidth - P.towerProj); // tower face
      const xo = s * (R.halfWidth + P.thickness);
      const skin = 0.5;
      // main wall mass behind the skins
      this.solid('buff', xi + s * skin, 0, zS, xo, P.height, zN);
      // south stub between the gate and the first segment
      this.solid('glazed', xi, 0, zS, xi + s * skin, P.height, 0, false);
      for (let k = 0, z0 = 0; z0 < zN - 0.01; k++, z0 += seg) {
        const z1 = Math.min(zN, z0 + seg);
        const isTower = k % 2 === 1;
        const xf = isTower ? xt : xi;
        const top = isTower ? P.towerHeight : P.height;
        const topC = isTower ? tc : hc;
        // street skin: glazed base, buff body, glazed crown
        this.solid('glazed', xf, 0, z0, xi + s * skin, 33 * C, z1, false);
        this.solid('buff', xf, 33 * C, z0, xi + s * skin, (topC - 16) * C, z1, false);
        this.solid('glazed', xf, (topC - 16) * C, z0, xi + s * skin, top, z1, false);
        if (isTower) {
          this.solid('buff', xi + s * skin, P.height, z0, xo - s * 1.5, top, z1, false);
          this.collide(xf, z0, xi, z1);
        }
        const f = makeFace([xf, 0, 0], [-s, 0, 0]);
        // face-u range for this segment: east face u = -z, west face u = +z
        const uA = s < 0 ? -z1 : z0;
        const uB = s < 0 ? -z0 : z1;
        const nL = Math.round(seg / (P.lionSpacingBricks * L));
        this.friezeSegment(f, uA, uB, lion, nL, s);
        lion += nL;
        // crown bands
        this.band('checker', f, uA, uB, topC - 16, topC - 14);
        this.band('rosette', f, uA, uB, topC - 14, topC - 10);
        this.band('merlonBand', f, uA, uB, topC - 4, topC - 1);
        if (isTower) {
          // slits up high (no vertical frames on the street towers: Berlin shows none)
          addSlit(this.slits, f, (uA + uB) / 2 - 1.6, P.height - 1.4, 0.3, 1.2, 0.8, this.revealBuff);
          addSlit(this.slits, f, (uA + uB) / 2 + 1.6, P.height - 1.4, 0.3, 1.2, 0.8, this.revealBuff);
          // the shallow returns of the tower
          for (const zr of [z0, z1]) {
            const nrm: [number, number, number] = zr === z0 ? [0, 0, -1] : [0, 0, 1];
            const rf = makeFace([0, 0, zr], nrm);
            const ua = worldU(new THREE.Vector3(xt, 0, zr), rf.normal) - worldU(rf.origin, rf.normal);
            const ub = worldU(new THREE.Vector3(xi, 0, zr), rf.normal) - worldU(rf.origin, rf.normal);
            const lo = Math.min(ua, ub),
              hi = Math.max(ua, ub);
            this.band('checker', rf, lo, hi, 6, 8);
            this.band('rosette', rf, lo, hi, 8, 12);
            this.band('checker', rf, lo, hi, 12, 14);
            this.turq(rf, lo, hi, 14, 26);
            this.band('checker', rf, lo, hi, 26, 28);
          }
          // merlons around the tower crown
          addMerlons(this.bucket, 'glazed', new THREE.Vector3(xt + s * 0.33, 0, z0), Z, z1 - z0, top, { spacing: 1.25 });
          addMerlons(this.bucket, 'glazed', new THREE.Vector3(xt, 0, z0 + 0.33), new THREE.Vector3(s, 0, 0), Math.abs(xo - xt) - 1.5, top, { spacing: 1.25 });
          addMerlons(this.bucket, 'glazed', new THREE.Vector3(xt, 0, z1 - 0.33), new THREE.Vector3(s, 0, 0), Math.abs(xo - xt) - 1.5, top, { spacing: 1.25 });
          if (k % 4 === 1) this.lampSpots.push({ pos: new THREE.Vector3(xt - s * 0.35, 3.4, (z0 + z1) / 2), kind: 'torch' });
        } else {
          addMerlons(this.bucket, 'glazed', new THREE.Vector3(xi + s * 0.33, 0, z0), Z, z1 - z0, P.height, { spacing: 1.25 });
        }
      }
      addMerlons(this.bucket, 'buff', new THREE.Vector3(xo - s * 0.33, 0, zS), Z, zN - zS, P.height);
      this.colliders.push({ x0: Math.min(xi, xo), z0: zS, x1: Math.max(xi, xo), z1: zN });
    }
    this.anchors.corridorNorth = new THREE.Vector3(0, 0, zN);
  }

  private buildNorthGate(): void {
    const N = LAYOUT.northGate;
    const R = LAYOUT.road;
    const w = R.halfWidth + LAYOUT.procWall.thickness;
    this.world('buff', archedBlock(-w, w, N.towerHeight - 3, N.halfWidth, 6.6, N.z0, N.z1));
    this.collide(-w, N.z0, -N.halfWidth, N.z1);
    this.collide(N.halfWidth, N.z0, w, N.z1);
    for (const s of [-1, 1]) {
      this.solid('buff', s * N.halfWidth * 2.2, 0, N.z1 - 9, s * w, N.towerHeight, N.z1 + 4);
      this.solid('buff', s * N.halfWidth * 2.2, 0, N.z0 - 2, s * w * 0.75, N.towerHeight, N.z0 + 7);
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * N.halfWidth * 2.2, 0, N.z1 + 3.67), new THREE.Vector3(s, 0, 0), w - N.halfWidth * 2.2, N.towerHeight, { spacing: 1.25 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * N.halfWidth * 2.2, 0, N.z0 - 1.67), new THREE.Vector3(s, 0, 0), w * 0.75 - N.halfWidth * 2.2, N.towerHeight, { spacing: 1.25 });
    }
    // glazed arch ribbons on the north and south faces of the North Gate
    const path = archPath(N.halfWidth, 6.6, 40, 0);
    this.bucket.add('band:rosette', archRibbon(path, 0.0, 0.333, N.z1 + 0.003, 1, 2));
    this.bucket.add('band:rosette', archRibbon(path, 0.0, 0.333, N.z0 - 0.003, -1, 2));
    // causeway across the moat
    const M = LAYOUT.moat;
    this.world('buff', boxMinMax(-7, -6, M.z0 - 4, 7, 0.0, M.z1 + 4));
    this.world('brickPave', boxMinMax(-7, -0.2, M.z0 - 4, 7, 0.012, M.z1 + 4));
    for (const s of [-1, 1]) this.world('buff', boxMinMax(s * 7, -6, M.z0 - 4, s * 7.6, 1.0, M.z1 + 4));
    this.anchors.northGate = new THREE.Vector3(0, 0, N.z0);
  }

  private gateTowerFace(f: WallFace, u0: number, u1: number, rows: number[], perRow: number, mirrored: boolean, topBand: number, bw = 0.3, firstBull = true): void {
    this.vborder(f, u0, u0 + bw, 6 * C, (topBand + 8) * C);
    this.vborder(f, u1 - bw, u1, 6 * C, (topBand + 8) * C);
    this.band('checker', f, u0 + bw, u1 - bw, 6, 8);
    this.band('rosette', f, u0 + bw, u1 - bw, 8, 12);
    this.band('checker', f, u0 + bw, u1 - bw, 12, 14);
    this.band('checker', f, u0, u1, topBand, topBand + 2);
    this.band('rosette', f, u0, u1, topBand + 2, topBand + 6);
    this.band('checker', f, u0, u1, topBand + 6, topBand + 8);
    rows.forEach((course, r) => {
      const bull = (r % 2 === 0) === firstBull;
      this.panelRow(bull ? this.keys.bull : this.keys.dragon, mirrored, f, u0 + bw, u1 - bw, perRow, course);
    });
  }

  private buildFrontGate(): void {
    const G = LAYOUT.frontGate;
    const xc = G.centreHalfWidth,
      xt = xc + G.towerWidth;
    const zF = G.zFront,
      zB = G.zFront - G.depth;
    const zC = zF - G.centreRecess;
    for (const s of [-1, 1]) {
      this.solid('glazed', s * xc, 0, zB, s * xt, G.towerHeight, zF);
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * xc, 0, zF - 0.33), new THREE.Vector3(s, 0, 0), G.towerWidth, G.towerHeight, { spacing: 1.2 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * xc, 0, zB + 0.33), new THREE.Vector3(s, 0, 0), G.towerWidth, G.towerHeight, { spacing: 1.2 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * (xc + 0.33), 0, zB), Z, G.depth, G.towerHeight, { spacing: 1.2 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * (xt - 0.33), 0, zB), Z, G.depth, G.towerHeight, { spacing: 1.2 });
      // the small returns between tower front and recessed centre
      const rf = makeFace([s * xc, 0, 0], [-s, 0, 0]);
      const ua = s < 0 ? -zF : zC,
        ub = s < 0 ? -zC : zF;
      this.band('checker', rf, ua, ub, 6, 8);
      this.band('rosette', rf, ua, ub, 8, 12);
      this.band('checker', rf, ua, ub, 12, 14);
    }
    this.world('glazed', archedBlock(-xc, xc, G.centreHeight, G.passageHalfWidth, G.archSpring, zB, zC));
    this.collide(-xc, zB, -G.passageHalfWidth, zC);
    this.collide(G.passageHalfWidth, zB, xc, zC);
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(-xc, 0, zC - 0.33), X, 2 * xc, G.centreHeight, { spacing: 1.2 });

    // façade: six alternating rows of aurochs and mušḫuššu, all walking towards the passage
    const f = makeFace([0, 0, zF], [0, 0, 1]);
    const rows = [16, 40, 64, 88, 112, 136];
    this.gateTowerFace(f, -xt, -xc, rows, 2, false, 152);
    this.gateTowerFace(f, xc, xt, rows, 2, true, 152);
    const tc = Math.round(G.towerHeight / C);
    for (const s of [-1, 1]) {
      const uMid = s * (xc + G.towerWidth / 2);
      addSlit(this.slits, f, uMid - 1.2, 15.4, 0.3, 1.6, 0.9, this.revealGlazed);
      addSlit(this.slits, f, uMid + 1.2, 15.4, 0.3, 1.6, 0.9, this.revealGlazed);
      const ua = s < 0 ? -xt : xc,
        ub = s < 0 ? -xc : xt;
      this.band('rosette', f, ua, ub, tc - 10, tc - 6);
      this.band('merlonBand', f, ua, ub, tc - 4, tc - 1);
    }
    // jambs flanking the arch: one animal per row
    const fc = makeFace([0, 0, zC], [0, 0, 1]);
    const hw = G.passageHalfWidth;
    const ribbon = 0.583;
    this.gateTowerFace(fc, -xc, -(hw + ribbon), [16, 40, 64], 1, false, 80, 0.12);
    this.gateTowerFace(fc, hw + ribbon, xc, [16, 40, 64], 1, true, 80, 0.12);
    const cc = Math.round(G.centreHeight / C);
    this.band('checker', fc, -xc, xc, 150, 152);
    this.band('rosette', fc, -xc, xc, 152, 156);
    this.band('checker', fc, -xc, xc, 156, 158);
    this.band('merlonBand', fc, -xc, xc, cc - 4, cc - 1);
    const path = archPath(hw, G.archSpring, 48, 0.0);
    const zr = zC + 0.003;
    this.bucket.add('band:yellow', archRibbon(path, 0.0, 0.083, zr, 1, 2));
    this.bucket.add('band:rosette', archRibbon(path, 0.083, 0.416, zr, 1, 2));
    this.bucket.add('band:checker', archRibbon(path, 0.416, 0.583, zr, 1, 2));

    // passage walls: inside, the animals walk south into the city
    for (const s of [-1, 1]) {
      const pf = makeFace([s * hw, 0, 0], [-s, 0, 0]);
      const zA = zC - 0.3,
        zBk = zB + 0.3;
      const uA = s < 0 ? -zA : zBk;
      const uB = s < 0 ? -zBk : zA;
      this.band('checker', pf, uA, uB, 6, 8);
      this.band('rosette', pf, uA, uB, 8, 12);
      this.band('checker', pf, uA, uB, 12, 14);
      this.panelRow(this.keys.bull, s > 0, pf, uA + 2.8, uB, 4, 18);
      this.band('checker', pf, uA, uB, 36, 38);
      this.panelRow(this.keys.dragon, s > 0, pf, uA + 2.8, uB, 3, 42);
      this.lampSpots.push({ pos: new THREE.Vector3(s * (hw - 0.25), 3.2, zB + 2.5), kind: 'torch' });
    }
    // bronze braziers on pedestals before the towers
    for (const s of [-1, 1]) {
      this.solid('buff', s * 3.6 - 0.6, 0, 3.4, s * 3.6 + 0.6, 1.1, 4.6, true);
      this.lampSpots.push({ pos: new THREE.Vector3(s * 3.6, 1.1, 4.0), kind: 'brazier' });
    }
    this.anchors.frontGate = new THREE.Vector3(0, 0, zF);
    this.anchors.frontArchTop = new THREE.Vector3(0, G.archSpring + hw, zC);
    this.buildDoors(hw, G.archSpring, zC - 0.7);
  }

  private buildDoors(hw: number, spring: number, zHinge: number): void {
    // Each leaf closes half of the arch: local x runs from the hinge (0) to the
    // meeting edge (leafW); its top follows the arch circle. Cedar, bronze-strapped.
    const leafW = hw - 0.04;
    const thick = 0.3;
    const top = (xl: number) => spring + Math.sqrt(Math.max(0, hw * hw - (hw - xl) * (hw - xl)));
    for (const s of [-1, 1]) {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(leafW, 0);
      const segs = 18;
      for (let i = 0; i <= segs; i++) {
        const xl = leafW * (1 - i / segs);
        shape.lineTo(xl, top(xl) - 0.02);
      }
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 4 });
      if (s > 0) g.translate(0, 0, -thick);
      const m = new THREE.Matrix4().makeRotationY(Math.PI / 2 - 0.035 * s);
      m.setPosition(s * (hw - 0.02), 0, zHinge);
      g.applyMatrix4(m);
      this.world('wood', g);
      for (const y of [0.55, 2.4, 4.25, 6.1, 7.95]) {
        const band = new THREE.BoxGeometry(leafW - 0.1, 0.17, thick + 0.04);
        band.translate(leafW / 2, y, s > 0 ? -thick / 2 : thick / 2);
        band.applyMatrix4(m);
        this.bucket.add('bronze', band);
        for (let k = 0; k < 6; k++) {
          const boss = new THREE.SphereGeometry(0.05, 8, 6);
          boss.translate(0.2 + k * ((leafW - 0.4) / 5), y, s > 0 ? -thick - 0.03 : thick + 0.03);
          boss.applyMatrix4(m);
          this.bucket.add('bronze', boss);
        }
      }
    }
  }

  private buildLightWell(): void {
    const Ct = LAYOUT.court;
    const G = LAYOUT.frontGate;
    const M = LAYOUT.rearGate;
    const xw = G.centreHalfWidth;
    for (const s of [-1, 1]) {
      this.solid('glazed', s * xw, 0, Ct.z1, s * (M.centreHalfWidth + M.towerWidth), Ct.wallHeight, Ct.z0);
      const f = makeFace([s * xw, 0, 0], [-s, 0, 0]);
      const uA = s < 0 ? -Ct.z0 : Ct.z1;
      const uB = s < 0 ? -Ct.z1 : Ct.z0;
      this.band('checker', f, uA, uB, 6, 8);
      this.band('rosette', f, uA, uB, 8, 12);
      this.band('checker', f, uA, uB, 12, 14);
      this.band('checker', f, uA, uB, 150, 152);
      this.band('rosette', f, uA, uB, 152, 156);
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * (xw + 0.33), 0, Ct.z1), Z, Ct.z0 - Ct.z1, Ct.wallHeight, { spacing: 1.2 });
    }
  }

  private buildMainGate(): void {
    const G = LAYOUT.rearGate;
    const xc = G.centreHalfWidth,
      xt = xc + G.towerWidth;
    const zF = G.zFront,
      zB = G.zFront - G.depth;
    const zC = zF - G.centreRecess;
    for (const s of [-1, 1]) {
      this.solid('glazed', s * xc, 0, zB, s * xt, G.towerHeight, zF);
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * xc, 0, zF - 0.33), new THREE.Vector3(s, 0, 0), G.towerWidth, G.towerHeight, { spacing: 1.25 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * xc, 0, zB + 0.33), new THREE.Vector3(s, 0, 0), G.towerWidth, G.towerHeight, { spacing: 1.25 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * (xc + 0.33), 0, zB), Z, G.depth, G.towerHeight, { spacing: 1.25 });
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(s * (xt - 0.33), 0, zB), Z, G.depth, G.towerHeight, { spacing: 1.25 });
    }
    this.world('glazed', archedBlock(-xc, xc, G.centreHeight, G.passageHalfWidth, G.archSpring, zB, zC));
    this.collide(-xc, zB, -G.passageHalfWidth, zC);
    this.collide(G.passageHalfWidth, zB, xc, zC);
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(-xc, 0, zC - 0.33), X, 2 * xc, G.centreHeight, { spacing: 1.25 });
    addMerlons(this.bucket, 'glazed', new THREE.Vector3(-xc, 0, zB + 0.33), X, 2 * xc, G.centreHeight, { spacing: 1.25 });

    // north faces: rows visible above the front gate
    const f = makeFace([0, 0, zF], [0, 0, 1]);
    this.gateTowerFace(f, -xt, -xc, [160, 184, 208, 232], 3, false, 248, 0.3, false);
    this.gateTowerFace(f, xc, xt, [160, 184, 208, 232], 3, true, 248, 0.3, false);
    const rt = Math.round(G.towerHeight / C);
    for (const s of [-1, 1]) {
      const uMid = s * (xc + G.towerWidth / 2);
      for (const du of [-2.2, 0, 2.2]) addSlit(this.slits, f, uMid + du, 22.6, 0.34, 1.7, 0.9, this.revealGlazed);
      const ua = s < 0 ? -xt : xc,
        ub = s < 0 ? -xc : xt;
      this.band('rosette', f, ua, ub, rt - 10, rt - 6);
      this.band('merlonBand', f, ua, ub, rt - 4, rt - 1);
    }
    // recessed centre facing the light-well
    const fc = makeFace([0, 0, zC], [0, 0, 1]);
    const hw = G.passageHalfWidth;
    this.gateTowerFace(fc, -xc, -(hw + 0.583), [16, 40, 64, 88], 1, false, 112, 0.2);
    this.gateTowerFace(fc, hw + 0.583, xc, [16, 40, 64, 88], 1, true, 112, 0.2);
    const rc = Math.round(G.centreHeight / C);
    this.band('checker', fc, -xc, xc, 170, 172);
    this.band('rosette', fc, -xc, xc, 172, 176);
    this.band('checker', fc, -xc, xc, 176, 178);
    this.band('merlonBand', fc, -xc, xc, rc - 4, rc - 1);
    const path = archPath(hw, G.archSpring, 48, 0.0);
    this.bucket.add('band:yellow', archRibbon(path, 0.0, 0.083, zC + 0.003, 1, 2));
    this.bucket.add('band:rosette', archRibbon(path, 0.083, 0.416, zC + 0.003, 1, 2));
    this.bucket.add('band:checker', archRibbon(path, 0.416, 0.583, zC + 0.003, 1, 2));

    // south face towards the city plaza
    const fs = makeFace([0, 0, zB], [0, 0, -1]);
    // on this face dirU = -X: the west tower lies at u in [-xt, -xc]
    for (const [ua, ub, mir] of [
      [-xt, -xc, false],
      [xc, xt, true],
    ] as [number, number, boolean][]) {
      this.gateTowerFace(fs, ua, ub, [16, 40, 64, 88, 112, 136, 160], 3, mir, 176, 0.3, true);
      this.band('rosette', fs, ua, ub, rt - 10, rt - 6);
      this.band('merlonBand', fs, ua, ub, rt - 4, rt - 1);
    }
    this.gateTowerFace(fs, -xc, -(hw + 0.583), [16, 40, 64, 88], 1, false, 112, 0.2);
    this.gateTowerFace(fs, hw + 0.583, xc, [16, 40, 64, 88], 1, true, 112, 0.2);
    this.band('rosette', fs, -xc, xc, 172, 176);
    this.band('merlonBand', fs, -xc, xc, rc - 4, rc - 1);
    this.bucket.add('band:yellow', archRibbon(path, 0.0, 0.083, zB - 0.003, -1, 2));
    this.bucket.add('band:rosette', archRibbon(path, 0.083, 0.416, zB - 0.003, -1, 2));
    this.bucket.add('band:checker', archRibbon(path, 0.416, 0.583, zB - 0.003, -1, 2));
    // passage
    for (const s of [-1, 1]) {
      const pf = makeFace([s * hw, 0, 0], [-s, 0, 0]);
      const zA = zC - 0.3,
        zBk = zB + 0.3;
      const uA = s < 0 ? -zA : zBk;
      const uB = s < 0 ? -zBk : zA;
      this.band('checker', pf, uA, uB, 6, 8);
      this.band('rosette', pf, uA, uB, 8, 12);
      this.band('checker', pf, uA, uB, 12, 14);
      this.panelRow(this.keys.dragon, s > 0, pf, uA, uB, 11, 18);
      this.band('checker', pf, uA, uB, 34, 36);
      this.panelRow(this.keys.bull, s > 0, pf, uA, uB, 14, 40);
      for (const zz of [zC - 8, zC - 22]) this.lampSpots.push({ pos: new THREE.Vector3(s * (hw - 0.25), 3.2, zz), kind: 'torch' });
    }
    for (const s of [-1, 1]) {
      this.solid('buff', s * 3.8 - 0.6, 0, zB - 4.6, s * 3.8 + 0.6, 1.1, zB - 3.4, true);
      this.lampSpots.push({ pos: new THREE.Vector3(s * 3.8, 1.1, zB - 4.0), kind: 'brazier' });
    }
    this.anchors.rearGate = new THREE.Vector3(0, 0, zF);
    this.anchors.rearGateSouth = new THREE.Vector3(0, 0, zB);
  }

  private buildCityWalls(): void {
    const O = LAYOUT.outerWall;
    const I = LAYOUT.innerWall;
    const R = LAYOUT.road;
    const P = LAYOUT.procWall;
    const G = LAYOUT.rearGate;
    for (const s of [-1, 1]) {
      // outer wall (Nēmetti-Enlil)
      const xa = s * (LAYOUT.frontGate.centreHalfWidth + LAYOUT.frontGate.towerWidth);
      const xb = s * O.extent;
      this.solid('buff', xa, 0, O.zNorth - O.thickness, xb, O.height, O.zNorth);
      addMerlons(this.bucket, 'buff', new THREE.Vector3(s * (R.halfWidth + P.thickness), 0, O.zNorth - 0.3), new THREE.Vector3(s, 0, 0), O.extent - (R.halfWidth + P.thickness), O.height);
      for (let x = R.halfWidth + P.thickness + 12; x < O.extent - 5; x += O.towerEvery) {
        const xx = s * x;
        this.solid('buff', xx - O.towerWidth / 2, 0, O.zNorth - O.thickness, xx + O.towerWidth / 2, O.towerHeight, O.zNorth + O.towerProj);
        addMerlons(this.bucket, 'buff', new THREE.Vector3(xx - O.towerWidth / 2, 0, O.zNorth + O.towerProj - 0.3), X, O.towerWidth, O.towerHeight, { spacing: 1.25 });
      }
      // inner wall (Imgur-Enlil)
      const xi = s * (G.centreHalfWidth + G.towerWidth);
      const xj = s * I.extent;
      this.solid('buff', xi, 0, I.zNorth - I.thickness, xj, I.height, I.zNorth);
      addMerlons(this.bucket, 'glazed', new THREE.Vector3(xi, 0, I.zNorth - 0.3), new THREE.Vector3(s, 0, 0), Math.abs(xj - xi), I.height);
      addMerlons(this.bucket, 'buff', new THREE.Vector3(xi, 0, I.zNorth - I.thickness + 0.3), new THREE.Vector3(s, 0, 0), Math.abs(xj - xi), I.height);
      for (let x = Math.abs(xi) + 10; x < I.extent - 5; x += I.towerEvery) {
        const xx = s * x;
        this.solid('buff', xx - I.towerWidth / 2, 0, I.zNorth - I.thickness - 2, xx + I.towerWidth / 2, I.towerHeight, I.zNorth + I.towerProj);
        addMerlons(this.bucket, 'glazed', new THREE.Vector3(xx - I.towerWidth / 2, 0, I.zNorth + I.towerProj - 0.3), X, I.towerWidth, I.towerHeight, { spacing: 1.25 });
        addMerlons(this.bucket, 'buff', new THREE.Vector3(xx - I.towerWidth / 2, 0, I.zNorth - I.thickness - 1.7), X, I.towerWidth, I.towerHeight, { spacing: 1.25 });
      }
    }
  }

  // ------------------------------------------------------------------ meshes
  private flush(): void {
    const m = this.mats;
    const materialFor = (key: string): THREE.Material | null => {
      if (key === 'glazed') return m.glazed;
      if (key === 'buff') return m.buff;
      if (key === 'limestone') return m.limestone;
      if (key === 'breccia') return m.breccia;
      if (key === 'brickPave') return m.brickPave;
      if (key === 'turq') return m.glazedTurq;
      if (key === 'void') return m.voidMat;
      if (key === 'wood') return m.wood;
      if (key === 'bronze') return m.bronze;
      if (key.startsWith('band:')) return m.bands[key.slice(5) as keyof typeof m.bands] ?? null;
      return null;
    };
    if (this.slits.length) {
      const slits = new THREE.Mesh(mergeGeometries(this.slits, false)!, makeRecessMaterial());
      slits.name = 'mon:slits';
      slits.receiveShadow = true;
      this.group.add(slits);
    }
    for (const key of this.bucket.keys()) {
      const mat = materialFor(key);
      const geo = this.bucket.build(key);
      if (!mat || !geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `mon:${key}`;
      const isOverlay = key.startsWith('band:') || key === 'turq' || key === 'void';
      const isFloor = key === 'limestone' || key === 'breccia' || key === 'brickPave';
      mesh.castShadow = !isOverlay && !isFloor;
      mesh.receiveShadow = true;
      if (key === 'glazed' || key === 'buff') mesh.layers.enable(VOLUME_LAYER);
      this.group.add(mesh);
    }
  }
}
