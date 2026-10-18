// Geometry helpers: world-space boxes, planar world UVs, merging.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Axis-aligned (optionally Y-rotated) box with its base at y. */
export function boxAt(
  w: number,
  h: number,
  d: number,
  x: number,
  yBase: number,
  z: number,
  rotY = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  _q.setFromEuler(_e.set(0, rotY, 0));
  _m.compose(_p.set(x, yBase + h / 2, z), _q, _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

/** Box from min/max corners. */
export function boxMinMax(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  return boxAt(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), (x0 + x1) / 2, Math.min(y0, y1), (z0 + z1) / 2);
}

/**
 * Replaces UVs by a planar projection along the dominant normal axis, in metres
 * divided by tile size. Keeps brick courses aligned across separate pieces.
 */
export function applyWorldUV(g: THREE.BufferGeometry, tileU: number, tileV = tileU): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  // use the face normal (average of the 3 verts) so a triangle never splits projections
  for (let i = 0; i < pos.count; i += 3) {
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = 0; k < 3; k++) {
      nx += nor.getX(i + k);
      ny += nor.getY(i + k);
      nz += nor.getZ(i + k);
    }
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k),
        y = pos.getY(i + k),
        z = pos.getZ(i + k);
      let u: number, v: number;
      if (ay >= ax && ay >= az) {
        u = x;
        v = -z;
      } else if (ax >= az) {
        u = nx > 0 ? -z : z;
        v = y;
      } else {
        u = nz > 0 ? x : -x;
        v = y;
      }
      uv[(i + k) * 2] = u / tileU;
      uv[(i + k) * 2 + 1] = v / tileV;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    let gg = g.index ? g.toNonIndexed() : g;
    // ensure identical attribute sets
    if (!gg.getAttribute('normal')) gg.computeVertexNormals();
    if (!gg.getAttribute('uv')) {
      gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(gg.getAttribute('position').count * 2), 2));
    }
    for (const name of Object.keys(gg.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') gg.deleteAttribute(name);
    }
    gg.morphAttributes = {};
    return gg;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('mergeGeometries failed');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Utility for building static meshes grouped by material key. */
export class GeometryBucket {
  private buckets = new Map<string, THREE.BufferGeometry[]>();

  add(key: string, g: THREE.BufferGeometry): void {
    let arr = this.buckets.get(key);
    if (!arr) {
      arr = [];
      this.buckets.set(key, arr);
    }
    arr.push(g);
  }

  keys(): string[] {
    return [...this.buckets.keys()];
  }

  build(key: string): THREE.BufferGeometry | null {
    const arr = this.buckets.get(key);
    if (!arr || arr.length === 0) return null;
    return merge(arr);
  }
}
