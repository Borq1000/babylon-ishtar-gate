// Shared building blocks for the monumental architecture: wall faces with
// brick-aligned coordinates, ornamental band strips, stepped Mesopotamian
// crenellations, arrow-slit windows and arched passages.

import * as THREE from 'three';
import { boxAt, GeometryBucket } from '../utils/geometry';
import { C, L } from '../world/Layout';

const UP = new THREE.Vector3(0, 1, 0);

/** A vertical wall face: points are origin + dirU·u + up·y; normal points outwards. */
export interface WallFace {
  origin: THREE.Vector3;
  dirU: THREE.Vector3;
  normal: THREE.Vector3;
}

/** dirU is derived as up × normal, so (dirU, up, normal) is always right-handed and
 *  face-u increases together with the wall's world brick coordinate. */
export function makeFace(origin: [number, number, number], normal: [number, number, number]): WallFace {
  const n = new THREE.Vector3(...normal).normalize();
  return { origin: new THREE.Vector3(...origin), dirU: UP.clone().cross(n).normalize(), normal: n };
}

/** Wall-consistent horizontal brick coordinate (matches applyWorldUV) at a world point. */
export function worldU(p: THREE.Vector3, normal: THREE.Vector3): number {
  const ax = Math.abs(normal.x),
    az = Math.abs(normal.z);
  if (ax >= az) return normal.x > 0 ? -p.z : p.z;
  return normal.z > 0 ? p.x : -p.x;
}

export function facePoint(f: WallFace, u: number, y: number, off = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(f.origin).addScaledVector(f.dirU, u).addScaledVector(UP, y).addScaledVector(f.normal, off);
}

/** Matrix whose local axes are (dirU, up, normal), placed at (u, y) on the face. */
export function faceMatrix(f: WallFace, u: number, y: number, off: number): THREE.Matrix4 {
  const p = facePoint(f, u, y, off);
  return new THREE.Matrix4().makeBasis(f.dirU, UP, f.normal).setPosition(p);
}

/**
 * Flat strip on a face between u0..u1 and y0..y1, slightly in front of it.
 * Texture u follows the wall's world brick coordinate (so joints align),
 * texture v spans the strip height.
 */
export function stripGeometry(f: WallFace, u0: number, u1: number, y0: number, y1: number, off: number, tileU: number): THREE.BufferGeometry {
  const p00 = facePoint(f, u0, y0, off);
  const p10 = facePoint(f, u1, y0, off);
  const p01 = facePoint(f, u0, y1, off);
  const p11 = facePoint(f, u1, y1, off);
  const pos = new Float32Array([...p00.toArray(), ...p10.toArray(), ...p11.toArray(), ...p00.toArray(), ...p11.toArray(), ...p01.toArray()]);
  const uA = worldU(p00, f.normal) / tileU,
    uB = worldU(p10, f.normal) / tileU;
  const uv = new Float32Array([uA, 0, uB, 0, uB, 1, uA, 0, uB, 1, uA, 1]);
  const n = f.normal;
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor.set([n.x, n.y, n.z], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // make sure the triangle faces outwards
  const e1 = p10.clone().sub(p00),
    e2 = p11.clone().sub(p00);
  if (e1.cross(e2).dot(n) < 0) {
    const idx = [0, 2, 1, 3, 5, 4];
    const p2 = new Float32Array(18),
      u2 = new Float32Array(12);
    idx.forEach((s, d) => {
      p2.set(pos.subarray(s * 3, s * 3 + 3), d * 3);
      u2.set(uv.subarray(s * 2, s * 2 + 2), d * 2);
    });
    g.setAttribute('position', new THREE.BufferAttribute(p2, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(u2, 2));
  }
  return g;
}

/** Stepped (ziggurat-profile) merlons along a line on top of a wall. */
export function addMerlons(
  bucket: GeometryBucket,
  key: string,
  start: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  topY: number,
  opts: { spacing?: number; width?: number; depth?: number; height?: number; outward?: THREE.Vector3 } = {},
): void {
  const spacing = opts.spacing ?? 1.3;
  const w = opts.width ?? 0.95;
  const d = opts.depth ?? 0.6;
  const h = opts.height ?? 1.0;
  const n = Math.max(1, Math.floor(length / spacing));
  const pad = (length - n * spacing) / 2;
  const rot = Math.atan2(dir.x, dir.z) - Math.PI / 2;
  const steps = [
    [1.0, 0.36],
    [0.68, 0.32],
    [0.36, 0.32],
  ];
  for (let i = 0; i < n; i++) {
    const c = start.clone().addScaledVector(dir, pad + (i + 0.5) * spacing);
    if (opts.outward) c.addScaledVector(opts.outward, 0);
    let y = topY;
    for (const [sw, sh] of steps) {
      bucket.add(key, boxAt(w * sw, h * sh, d, c.x, y, c.z, rot));
      y += h * sh;
    }
  }
}

/**
 * Slit window: a quad on the face carrying the cavity size (aRecess) and the
 * reveal colour; the recess material ray-casts the opening behind it.
 */
export function addSlit(list: THREE.BufferGeometry[], f: WallFace, u: number, y: number, w = 0.32, h = 1.3, depth = 0.8, reveal = new THREE.Color(0.5, 0.4, 0.25)): void {
  const g = new THREE.PlaneGeometry(w, h).toNonIndexed();
  g.applyMatrix4(faceMatrix(f, u, y + h / 2, 0.003));
  const n = g.getAttribute('position').count;
  const rec = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rec.set([w, h, depth], i * 3);
    col.set([reveal.r, reveal.g, reveal.b], i * 3);
  }
  g.setAttribute('aRecess', new THREE.BufferAttribute(rec, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  list.push(g);
}

/**
 * Block with an arched passage running along Z, as an extruded profile:
 * x in [xMin, xMax], y in [0, height], passage half-width hw, jamb height spring.
 */
export function archedBlock(
  xMin: number,
  xMax: number,
  height: number,
  hw: number,
  spring: number,
  zBack: number,
  zFront: number,
  xCenter = 0,
  segments = 28,
): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(xMin, 0);
  s.lineTo(xCenter - hw, 0);
  s.lineTo(xCenter - hw, spring);
  // arc from the left jamb over the top to the right jamb (clockwise in screen terms)
  for (let i = 1; i <= segments; i++) {
    const a = Math.PI - (i / segments) * Math.PI;
    s.lineTo(xCenter + Math.cos(a) * hw, spring + Math.sin(a) * hw);
  }
  s.lineTo(xCenter + hw, 0);
  s.lineTo(xMax, 0);
  s.lineTo(xMax, height);
  s.lineTo(xMin, height);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: zFront - zBack, bevelEnabled: false, curveSegments: segments });
  g.translate(0, 0, zBack);
  return g;
}

/** Points along the inner outline of an arch opening (jambs + semicircle) for ribbons. */
export function archPath(hw: number, spring: number, segs = 40, yBottom = 0): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(-hw, yBottom));
  pts.push(new THREE.Vector2(-hw, spring));
  for (let i = 1; i < segs; i++) {
    const a = Math.PI - (i / segs) * Math.PI;
    pts.push(new THREE.Vector2(Math.cos(a) * hw, spring + Math.sin(a) * hw));
  }
  pts.push(new THREE.Vector2(hw, spring));
  pts.push(new THREE.Vector2(hw, yBottom));
  return pts;
}

/**
 * Ribbon that follows an arch outline on a face plane z = zFace (normal +Z or -Z),
 * offset outwards from the opening by [r0, r1]; u = arc length / tileU, v across.
 */
export function archRibbon(
  path: THREE.Vector2[],
  r0: number,
  r1: number,
  zFace: number,
  normalZ: 1 | -1,
  tileU: number,
  xCenter = 0,
): THREE.BufferGeometry {
  // outward normals of the opening outline (pointing away from the opening)
  const n = path.length;
  const offsetPt = (i: number, r: number): THREE.Vector2 => {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    // the path runs up the left jamb, over the crown and down the right jamb, so the
    // opening lies on the RIGHT of the direction of travel; the left normal points away
    const outN = new THREE.Vector2(-t.y, t.x);
    return p.clone().addScaledVector(outN, r);
  };
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  let acc = 0;
  const lens = [0];
  for (let i = 1; i < n; i++) {
    acc += path[i].distanceTo(path[i - 1]);
    lens.push(acc);
  }
  for (let i = 0; i < n - 1; i++) {
    const a0 = offsetPt(i, r0),
      a1 = offsetPt(i, r1),
      b0 = offsetPt(i + 1, r0),
      b1 = offsetPt(i + 1, r1);
    const ua = lens[i] / tileU,
      ub = lens[i + 1] / tileU;
    const quad = [
      [a0, ua, 0],
      [b0, ub, 0],
      [b1, ub, 1],
      [a0, ua, 0],
      [b1, ub, 1],
      [a1, ua, 1],
    ] as const;
    const order = normalZ > 0 ? [0, 1, 2, 3, 4, 5] : [0, 2, 1, 3, 5, 4];
    for (const k of order) {
      const [p, u, v] = quad[k];
      pos.push(p.x + xCenter, p.y, zFace);
      uv.push(u, v);
      nor.push(0, 0, normalZ);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

export const courses = (n: number) => n * C;
export const bricks = (n: number) => n * L;
