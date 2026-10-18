// 2D collision for the walking viewer: a circle against axis-aligned boxes
// (walls, towers, gate blocks, houses) stored in a uniform grid, plus a union
// of walkable rectangles that bounds exploration to the prepared area.

import type { Box2 } from '../architecture/Monuments';

export class CollisionWorld {
  private cell = 16;
  private grid = new Map<string, Box2[]>();
  private walkable: Box2[] = [];

  constructor(boxes: Box2[], walkable: Box2[]) {
    this.walkable = walkable;
    for (const b of boxes) {
      const cx0 = Math.floor(b.x0 / this.cell),
        cx1 = Math.floor(b.x1 / this.cell);
      const cz0 = Math.floor(b.z0 / this.cell),
        cz1 = Math.floor(b.z1 / this.cell);
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 4000) continue; // skip giant boxes (walkable rects bound those areas)
      for (let x = cx0; x <= cx1; x++)
        for (let z = cz0; z <= cz1; z++) {
          const k = `${x},${z}`;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(b);
        }
    }
  }

  private inWalkable(x: number, z: number, r: number): boolean {
    return this.walkable.some((w) => x > w.x0 + r && x < w.x1 - r && z > w.z0 + r && z < w.z1 - r);
  }

  /** Moves a circle from (x, z) by (dx, dz), sliding along obstacles. */
  move(x: number, z: number, dx: number, dz: number, r: number): [number, number] {
    let nx = x + dx,
      nz = z + dz;
    // bound to the prepared area, axis by axis so we slide along the edge
    if (!this.inWalkable(nx, nz, r)) {
      if (this.inWalkable(nx, z, r)) nz = z;
      else if (this.inWalkable(x, nz, r)) nx = x;
      else {
        nx = x;
        nz = z;
      }
    }
    for (let iter = 0; iter < 3; iter++) {
      const cx = Math.floor(nx / this.cell),
        cz = Math.floor(nz / this.cell);
      let pushed = false;
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const arr = this.grid.get(`${gx},${gz}`);
          if (!arr) continue;
          for (const b of arr) {
            // closest point on the box
            const px = Math.max(b.x0, Math.min(nx, b.x1));
            const pz = Math.max(b.z0, Math.min(nz, b.z1));
            let ddx = nx - px,
              ddz = nz - pz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 >= r * r) continue;
            if (d2 < 1e-10) {
              // centre inside the box: push out along the shallowest axis
              const l = nx - b.x0,
                rr = b.x1 - nx,
                t = nz - b.z0,
                bt = b.z1 - nz;
              const m = Math.min(l, rr, t, bt);
              if (m === l) nx = b.x0 - r;
              else if (m === rr) nx = b.x1 + r;
              else if (m === t) nz = b.z0 - r;
              else nz = b.z1 + r;
            } else {
              const d = Math.sqrt(d2);
              ddx /= d;
              ddz /= d;
              nx = px + ddx * r;
              nz = pz + ddz * r;
            }
            pushed = true;
          }
        }
      if (!pushed) break;
    }
    return [nx, nz];
  }
}
