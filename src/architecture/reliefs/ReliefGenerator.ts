// CPU generator for moulded glazed-brick relief panels.
//
// Pipeline per animal:
//   1. every layer outline is rasterised (Path2D, anti-aliased) into a coverage mask;
//   2. an exact Euclidean distance transform gives distance-to-edge inside the mask;
//   3. a "sculpting" profile (rounded bevel + broad volume) turns distance into height;
//   4. ornament patterns (mane locks, scales, curls) add relief + glaze colour;
//   5. brick joints are cut through everything, exactly like the real moulded bricks;
//   6. normal / AO / roughness / height maps are derived from the final height field.
//
// The panel width is (cols + 0.5) bricks and its outline follows the running-bond
// joints (an alpha "tooth" mask), so panels sit seamlessly inside brick walls.

import type { AnimalDef, PatternKind, Pt, ReliefLayer, ReliefMaps } from './ReliefTypes';

export const BR_L = 1 / 3;
export const BR_C = 1 / 12;
export const BR_J = 0.0055;
export const RELIEF_H_MIN = -0.006;
export const RELIEF_H_MAX = 0.07;

type RGB = [number, number, number];

const hexRGB = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---- smooth value noise for glaze mottling ----
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx),
    uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy),
    b = hash2(ix + 1, iy),
    c = hash2(ix, iy + 1),
    d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, o = 4): number {
  let s = 0,
    a = 0.5;
  for (let i = 0; i < o; i++) {
    s += a * vnoise(x, y);
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 3.1;
    a *= 0.5;
  }
  return s;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- canvas helpers ----
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { ctx: Ctx; canvas: HTMLCanvasElement | OffscreenCanvas } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

/** Closed (or open) uniform Catmull-Rom spline through points, as cubic Béziers. */
export function splinePath(path: Path2D, pts: Pt[], closed: boolean, tx: (p: Pt) => Pt): void {
  const n = pts.length;
  if (n < 2) return;
  const P = (i: number): Pt => {
    if (closed) return tx(pts[((i % n) + n) % n]);
    return tx(pts[Math.max(0, Math.min(n - 1, i))]);
  };
  const p0 = P(0);
  path.moveTo(p0[0], p0[1]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = P(i - 1),
      b = P(i),
      c = P(i + 1),
      d = P(i + 2);
    const c1: Pt = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6];
    const c2: Pt = [c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6];
    path.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], c[0], c[1]);
  }
  if (closed) path.closePath();
}

// ---- exact Euclidean distance transform (Felzenszwalb & Huttenlocher) ----
const EDT_INF = 1e20;
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distance (px) from inside pixels to the nearest outside pixel, within a bbox. */
function distanceInside(
  cov: Float32Array,
  W: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Float32Array,
): void {
  const w = x1 - x0,
    h = y1 - y0;
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) grid[y * w + x] = cov[(y + y0) * W + x + x0] >= 0.5 ? EDT_INF : 0;
  const n = Math.max(w, h);
  const f = new Float32Array(n),
    d = new Float32Array(n),
    v = new Int32Array(n),
    z = new Float32Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[(y + y0) * W + x + x0] = Math.sqrt(d[x]);
  }
}

// ---- ornament patterns: return [heightOffset(m), colourMix 0..1, darkLine 0..1] ----
interface PatternSample {
  h: number;
  mix: number;
  line: number;
}

function patternAt(kind: PatternKind, layer: ReliefLayer, center: Pt | null, xm: number, ym: number, out: PatternSample): void {
  out.h = 0;
  out.mix = 0;
  out.line = 0;
  if (kind === 'none') return;
  const S = layer.patternScale ?? 0.06;
  if (kind === 'curls') {
    // staggered rows of small curls (bull hair)
    const sx = S,
      sy = S * 0.9;
    const row = Math.floor(ym / sy);
    const off = (row & 1) * 0.5;
    const col = Math.floor(xm / sx + off);
    const cx = (col + 0.5 - off) * sx,
      cy = (row + 0.5) * sy;
    const r = Math.hypot(xm - cx, ym - cy) / (S * 0.42);
    if (r < 1) {
      const ring = Math.exp(-Math.pow((r - 0.62) / 0.18, 2));
      const ang = Math.atan2(ym - cy, xm - cx);
      const spiral = 0.5 + 0.5 * Math.sin(ang + r * 9.0);
      out.h = 0.0035 * (1 - r * r) + 0.0012 * ring * spiral;
      out.mix = r < 0.92 ? 1 : 0;
      out.line = r > 0.86 && r < 1 ? 1 : ring * spiral > 0.8 ? 0.5 : 0;
    }
    return;
  }
  // locks / scales / hair: rows along a flow field
  let along: number, across: number;
  const rowLen = kind === 'scales' ? S * 0.75 : S;
  if (center) {
    const [cx, cy] = center;
    const dx = xm - cx,
      dy = ym - cy;
    const r = Math.hypot(dx, dy);
    along = r;
    // arc length measured on the row's mid radius (θ·r would shear rows into
    // fine stripes); the atan2 seam is placed on the +x side (inside the face)
    const rowMid = (Math.floor(r / rowLen) + 0.5) * rowLen;
    across = Math.atan2(dy, -dx) * rowMid;
  } else {
    const a = ((layer.flowAngle ?? 0) * Math.PI) / 180;
    along = xm * Math.cos(a) + ym * Math.sin(a);
    across = -xm * Math.sin(a) + ym * Math.cos(a);
  }
  if (kind === 'hair') {
    const w = S * 0.25;
    const t = across / w + Math.sin(along / (S * 0.8)) * 0.4;
    const f = t - Math.floor(t);
    out.h = 0.0015 * Math.sin(f * Math.PI);
    out.line = f < 0.12 ? 1 : 0;
    out.mix = 0;
    return;
  }
  const len = rowLen;
  const wid = kind === 'scales' ? S * 0.75 : S * 0.62;
  const row = Math.floor(along / len);
  const v = along / len - row;
  const a2 = across / wid + (row & 1) * 0.5;
  const u = a2 - Math.floor(a2);
  const cu = 2 * u - 1;
  const acu = Math.abs(cu);
  // scales: round tips; locks: flame-like pointed tips
  const tip = kind === 'scales' ? Math.sqrt(Math.max(0, 1 - cu * cu)) : 0.42 + 0.58 * (1 - Math.pow(acu, 1.6));
  const inside = v < tip;
  if (inside) {
    const lift = Math.min(1, v / 0.8) * (1 - cu * cu * 0.6);
    out.h = (kind === 'scales' ? 0.0022 : 0.005) * lift;
    out.mix = 1;
    // dark line only along the free (tip) edge, like the incised tuft outlines
    const tipDist = (tip - v) * len;
    out.line = tipDist < 0.0028 ? 1 : 0;
    if (kind === 'locks' && acu < 0.07 && v > 0.12 && v < tip - 0.2) out.line = Math.max(out.line, 0.55);
  } else {
    out.h = 0.0008;
    out.mix = 0.75;
  }
}

/** Builds height / colour / derived maps for one animal panel. */
export function generateRelief(def: AnimalDef, pxPerMetre: number): ReliefMaps {
  const panelW = (def.cols + 0.5) * BR_L;
  const panelH = def.rows * BR_C;
  const W = Math.round(panelW * pxPerMetre);
  const H = Math.round(panelH * pxPerMetre);
  const mpp = panelW / W; // metres per pixel
  const N = W * H;

  // def -> pixel transform (def y down; panel y measured from top in pixels)
  const { x: px0, y: py0, s } = def.place;
  const tx = (p: Pt): Pt => [(px0 + p[0] * s) / mpp, (py0 + p[1] * s) / mpp];

  const heights = new Float32Array(N); // relief height above brick face (m)
  const colR = new Float32Array(N),
    colG = new Float32Array(N),
    colB = new Float32Array(N);
  const lineMask = new Float32Array(N); // dark glaze lines
  const animal = new Float32Array(N); // coverage of any coloured layer
  const roughAdd = new Float32Array(N);

  const { ctx } = makeCanvas(W, H);
  const cov = new Float32Array(N);
  const dist = new Float32Array(N);
  const ps: PatternSample = { h: 0, mix: 0, line: 0 };

  for (const layer of def.layers) {
    // ---- rasterise coverage ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    const path = new Path2D();
    for (const sh of layer.shapes ?? []) splinePath(path, sh, true, tx);
    for (const poly of layer.polys ?? []) {
      poly.forEach((p, i) => {
        const q = tx(p);
        if (i === 0) path.moveTo(q[0], q[1]);
        else path.lineTo(q[0], q[1]);
      });
      path.closePath();
    }
    for (const e of layer.ellipses ?? []) {
      const c = tx([e[0], e[1]]);
      path.moveTo(c[0] + (e[2] * s) / mpp, c[1]);
      path.ellipse(c[0], c[1], (e[2] * s) / mpp, (e[3] * s) / mpp, e[4], 0, Math.PI * 2);
    }
    ctx.fill(path, 'nonzero');
    for (const st of layer.strokes ?? []) {
      const sp = new Path2D();
      splinePath(sp, st.pts, false, tx);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = (st.width * s) / mpp;
      ctx.stroke(sp);
      if (st.taper) {
        // a thinner continuation for tapering tails
        ctx.lineWidth = (st.width * s * st.taper) / mpp;
        ctx.stroke(sp);
      }
    }
    const img = ctx.getImageData(0, 0, W, H).data;
    let bx0 = W,
      by0 = H,
      bx1 = 0,
      by1 = 0;
    for (let i = 0; i < N; i++) {
      const a = img[i * 4 + 3] / 255;
      cov[i] = a;
      if (a > 0) {
        const x = i % W,
          y = (i / W) | 0;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    if (bx1 < bx0) continue;
    bx0 = Math.max(0, bx0 - 2);
    by0 = Math.max(0, by0 - 2);
    bx1 = Math.min(W, bx1 + 3);
    by1 = Math.min(H, by1 + 3);
    distanceInside(cov, W, bx0, by0, bx1, by1, dist);

    const center: Pt | null = layer.flowCenter ? [px0 + layer.flowCenter[0] * s, py0 + layer.flowCenter[1] * s] : null;
    const colr = layer.color !== undefined ? hexRGB(layer.color) : null;
    const pcol = layer.patternColor !== undefined ? hexRGB(layer.patternColor) : null;
    const lineW = 0.0045; // m — dark separation line width
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = y * W + x;
        const c = cov[i];
        if (c <= 0) continue;
        const dm = Math.max(0, dist[i] - 0.5) * mpp + (c < 0.5 ? 0 : 0);
        const xm = x * mpp,
          ym = y * mpp;
        if (layer.incise) {
          const t = Math.min(1, dm / layer.bevel);
          heights[i] -= layer.dome * Math.sqrt(t) * c;
          lineMask[i] = Math.max(lineMask[i], c * 0.85);
          continue;
        }
        const t = Math.min(1, dm / Math.max(layer.bevel, 1e-4));
        // sculpt-only volumes (muscles) must blend in without a crease at their rim
        const prof = layer.mode === 'add' && layer.outline === false ? t * t * (3 - 2 * t) : 1 - Math.pow(1 - t, 2.2);
        let hL = layer.base + layer.dome * prof;
        if (layer.volume) hL += layer.volume * Math.pow(Math.min(1, dm / (layer.volumeDist ?? 0.1)), 0.6);
        let mixP = 0;
        let lineP = 0;
        if (layer.pattern && layer.pattern !== 'none') {
          patternAt(layer.pattern, layer, center, xm, ym, ps);
          // fade pattern in from the layer edge so outlines stay clean
          const fade = Math.min(1, dm / 0.01);
          hL += ps.h * fade;
          mixP = ps.mix * fade;
          lineP = ps.line * fade;
        }
        const prev = heights[i];
        const target = layer.mode === 'add' ? prev + hL : Math.max(prev, hL);
        heights[i] = prev + (target - prev) * c;
        if (colr) {
          let r = colr[0],
            g = colr[1],
            b = colr[2];
          if (pcol && mixP > 0) {
            r += (pcol[0] - r) * mixP;
            g += (pcol[1] - g) * mixP;
            b += (pcol[2] - b) * mixP;
          }
          colR[i] += (r - colR[i]) * c;
          colG[i] += (g - colG[i]) * c;
          colB[i] += (b - colB[i]) * c;
          animal[i] = Math.max(animal[i], c);
          // the new colour replaces any line below, then adds its own
          lineMask[i] *= 1 - c;
          if (layer.outline !== false && dm < lineW) lineMask[i] = Math.max(lineMask[i], c * (1 - dm / lineW) * 0.95);
          if (lineP > 0) lineMask[i] = Math.max(lineMask[i], lineP * 0.85 * c);
        } else if (lineP > 0) {
          lineMask[i] = Math.max(lineMask[i], lineP * 0.7 * c);
        }
        if (layer.pattern === 'locks') roughAdd[i] = 0.03;
      }
    }
  }

  // ---- bricks, glaze, joints -------------------------------------------------
  const bg = def.background.map(hexRGB);
  const band = def.bottomBand ? hexRGB(def.bottomBand.color) : null;
  const bandRows = def.bottomBand?.rows ?? 0;
  const mortar: RGB = [140, 132, 116];
  const dark: RGB = [38, 28, 22];
  const alpha = new Uint8Array(N);
  const finalH = new Float32Array(N);
  const rough = new Float32Array(N);
  const aoJ = new Float32Array(N);
  const outR = new Float32Array(N),
    outG = new Float32Array(N),
    outB = new Float32Array(N);

  for (let y = 0; y < H; y++) {
    const yb = (H - 1 - y + 0.5) * mpp; // metres from panel bottom
    const row = Math.floor(yb / BR_C);
    const off = (row & 1) * 0.5 * BR_L;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xm = (x + 0.5) * mpp;
      // tooth mask: even rows span [0, cols*L), odd rows [L/2, cols*L + L/2)
      const start = row & 1 ? BR_L * 0.5 : 0;
      const inPanel = xm >= start && xm < start + def.cols * BR_L;
      alpha[i] = inPanel ? 255 : 0;

      const col = Math.floor((xm + off) / BR_L);
      const lx = xm + off - col * BR_L;
      const ly = yb - row * BR_C;
      const jd = Math.min(lx, BR_L - lx, ly, BR_C - ly) - BR_J * 0.5;
      const id = hash2(col * 7 + 3, row * 13 + 5);
      const id2 = hash2(col * 3 + 11, row * 5 + 1);

      let h = heights[i];
      // brick face bevel / pillow (same recipe as the wall shader)
      const bevel = Math.sqrt(Math.min(1, Math.max(0, jd / 0.0045)));
      const cu = (lx / BR_L) * 2 - 1,
        cv = (ly / BR_C) * 2 - 1;
      const pillow = (1 - cu * cu * 0.6) * (1 - cv * cv * 0.8);
      const tilt = (id - 0.5) * 0.01 * (lx - BR_L / 2) + (id2 - 0.5) * 0.02 * (ly - BR_C / 2);
      if (jd < 0) {
        h = Math.min(h, 0) - 0.0045 + vnoise(xm * 120, yb * 120) * 0.0015;
      } else {
        h += bevel * (0.0018 + pillow * 0.0009 + tilt) - (1 - bevel) * 0.002;
      }
      finalH[i] = h;

      // colour
      const a = animal[i];
      let r: number, g: number, b: number;
      // background glaze: same recipe as glazedAlbedo() in bricks.glsl (firing
      // batches over the brick grid, a few light / dark / grey-teal bricks)
      const batch = vnoise(col / 3, row / 6);
      const tb = Math.min(1, Math.max(0, id * 0.7 + batch * 0.55 - 0.12));
      const wAB = smooth(0.15, 0.85, tb);
      const wC = smooth(0.88, 0.97, id2) * 0.65;
      const wD = (1 - smooth(0.04, 0.08, id2)) * 0.7;
      const wE = hash2(col + 57, row + 91) > 0.985 ? 0.6 : 0;
      const k = 0.93 + 0.14 * hash2(col + 101, row + 17);
      const mottN = fbm(xm * 22 + id * 5, yb * 22, 4);
      const mott = 0.84 + 0.32 * mottN;
      let br = 0,
        bgg = 0,
        bb = 0;
      for (let ch = 0; ch < 3; ch++) {
        let v = bg[0][ch] + (bg[1][ch] - bg[0][ch]) * wAB;
        v += (bg[2][ch] - v) * wC;
        v += (bg[3][ch] - v) * wD;
        v += (bg[4][ch] - v) * wE;
        v *= k * mott;
        if (ch === 0) br = v;
        else if (ch === 1) bgg = v;
        else bb = v;
      }
      if (band && row < bandRows) {
        br = band[0] * k * mott;
        bgg = band[1] * k * mott;
        bb = band[2] * k * mott;
      }
      // each moulded brick of the animal was glazed and fired on its own:
      // a little value and warmth variation per brick, plus pooling inside it
      const kA = 0.88 + 0.22 * hash2(col + 7, row + 29);
      const warm = hash2(col + 31, row + 3) - 0.5;
      const mottA = 0.92 + 0.16 * fbm(xm * 30 + 3, yb * 30 + id * 3, 3);
      r = br + (colR[i] * kA * mottA * (1 + 0.07 * warm) - br) * a;
      g = bgg + (colG[i] * kA * mottA - bgg) * a;
      b = bb + (colB[i] * kA * mottA * (1 - 0.14 * warm) - bb) * a;
      // dark glaze separation lines / incisions
      const ln = lineMask[i];
      r += (dark[0] - r) * ln;
      g += (dark[1] - g) * ln;
      b += (dark[2] - b) * ln;
      // thinner glaze at brick edges
      const edge = 1 - Math.min(1, Math.max(0, jd / 0.006));
      r += (0.5 * r + 60 - r) * edge * 0.35;
      g += (0.5 * g + 70 - g) * edge * 0.35;
      b += (0.5 * b + 75 - b) * edge * 0.35;
      let ro = 0.12 + 0.1 * id2 + 0.1 * (1 - mottN) + edge * 0.1 + roughAdd[i];
      if (jd < 0) {
        const m = 0.8 + 0.4 * vnoise(xm * 80, yb * 80);
        r = mortar[0] * m;
        g = mortar[1] * m;
        b = mortar[2] * m;
        ro = 0.92;
      }
      outR[i] = r;
      outG[i] = g;
      outB[i] = b;
      rough[i] = ro;
      aoJ[i] = jd < 0 ? 0.62 + 0.25 * Math.min(1, Math.max(0, (jd + 0.0055) / 0.0045)) : 1 - edge * 0.1;
    }
  }

  // ---- cavity AO from blurred height (summed-area table) ----
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += finalH[y * W + x];
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + rowSum;
    }
  }
  const R = Math.max(2, Math.round(0.02 / mpp));
  const boxMean = (x: number, y: number) => {
    const xa = Math.max(0, x - R),
      xb = Math.min(W, x + R + 1),
      ya = Math.max(0, y - R),
      yb = Math.min(H, y + R + 1);
    const sum = sat[yb * (W + 1) + xb] - sat[ya * (W + 1) + xb] - sat[yb * (W + 1) + xa] + sat[ya * (W + 1) + xa];
    return sum / ((xb - xa) * (yb - ya));
  };

  const albedo = new Uint8Array(N * 4);
  const normal = new Uint8Array(N * 4);
  const orm = new Uint8Array(N * 4);
  const hRange = RELIEF_H_MAX - RELIEF_H_MIN;
  for (let y = 0; y < H; y++) {
    const ty = H - 1 - y; // texture row (v up)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = (ty * W + x) * 4;
      albedo[o] = Math.max(0, Math.min(255, outR[i]));
      albedo[o + 1] = Math.max(0, Math.min(255, outG[i]));
      albedo[o + 2] = Math.max(0, Math.min(255, outB[i]));
      albedo[o + 3] = alpha[i];
      const xl = Math.max(0, x - 1),
        xr = Math.min(W - 1, x + 1);
      const yu = Math.max(0, y - 1),
        yd = Math.min(H - 1, y + 1);
      const dhdx = (finalH[y * W + xr] - finalH[y * W + xl]) / ((xr - xl) * mpp);
      const dhdy = (finalH[yu * W + x] - finalH[yd * W + x]) / ((yd - yu) * mpp); // +v is up
      let nx = -dhdx,
        ny = -dhdy,
        nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      normal[o] = (nx * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny * 0.5 + 0.5) * 255;
      normal[o + 2] = (nz * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
      const cav = Math.max(0, boxMean(x, y) - finalH[i]);
      const ao = Math.max(0.35, Math.min(1, aoJ[i] * (1 - cav * 45)));
      orm[o] = ao * 255;
      orm[o + 1] = Math.max(0.05, Math.min(1, rough[i])) * 255;
      orm[o + 2] = 0;
      orm[o + 3] = Math.max(0, Math.min(1, (finalH[i] - RELIEF_H_MIN) / hRange)) * 255;
    }
  }

  return { width: W, height: H, heights: finalH, albedo, normal, orm, panelW, panelH, heightMax: RELIEF_H_MAX };
}
