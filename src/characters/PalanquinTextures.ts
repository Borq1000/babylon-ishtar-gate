// Small canvas-drawn PBR sets for the god's palanquin: embossed gold sheet,
// lapis-lazuli panels with pyrite flecks in gold frames, and the red woollen
// canopy with a woven border. Heights are drawn in grey and turned into normal
// maps with a Sobel filter; everything stays a few hundred kilobytes.

import * as THREE from 'three';

type Ctx = CanvasRenderingContext2D;

interface CanvasSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.CanvasTexture;
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: Ctx } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

/** Deterministic value noise in [0, 1). */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function normalFromHeight(hc: HTMLCanvasElement, strength: number, wrap: boolean): THREE.DataTexture {
  const w = hc.width,
    h = hc.height;
  const src = hc.getContext('2d')!.getImageData(0, 0, w, h).data;
  const H = (x: number, y: number) => {
    if (wrap) {
      x = (x + w) % w;
      y = (y + h) % h;
    } else {
      x = Math.min(w - 1, Math.max(0, x));
      y = Math.min(h - 1, Math.max(0, y));
    }
    return src[(y * w + x) * 4] / 255;
  };
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) * strength;
      // canvas rows run downwards, texture v upwards
      const dy = (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1) - H(x - 1, y + 1) - 2 * H(x, y + 1) - H(x + 1, y + 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = ((h - 1 - y) * w + x) * 4;
      out[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  const t = new THREE.DataTexture(out, w, h);
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function finish(map: HTMLCanvasElement, height: HTMLCanvasElement, rough: HTMLCanvasElement, strength: number, wrap: boolean): CanvasSet {
  const m = new THREE.CanvasTexture(map);
  m.colorSpace = THREE.SRGBColorSpace;
  const r = new THREE.CanvasTexture(rough);
  for (const t of [m, r]) {
    t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
  }
  return { map: m, normalMap: normalFromHeight(height, strength, wrap), roughnessMap: r };
}

function rosette(ctx: Ctx, x: number, y: number, R: number, petals: number): void {
  ctx.beginPath();
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    ctx.moveTo(x, y);
    ctx.ellipse(x + Math.cos(a) * R * 0.55, y + Math.sin(a) * R * 0.55, R * 0.45, R * 0.2, a, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, R * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

/** Gold sheet hammered over cedar: repoussé rosettes in a lattice, seams, tarnish in the hollows. Tile ≈ 0.4 m. */
export function goldSheet(): CanvasSet {
  const S = 256;
  const { c: hc, ctx: h } = canvas(S, S);
  h.fillStyle = 'rgb(128,128,128)';
  h.fillRect(0, 0, S, S);
  const r = rnd(7);
  // hammer marks
  for (let i = 0; i < 900; i++) {
    const v = 110 + r() * 40;
    h.fillStyle = `rgba(${v},${v},${v},0.35)`;
    h.beginPath();
    h.arc(r() * S, r() * S, 2 + r() * 5, 0, Math.PI * 2);
    h.fill();
  }
  // sheet seams
  h.fillStyle = 'rgb(70,70,70)';
  h.fillRect(0, 0, S, 3);
  h.fillRect(0, 0, 3, S);
  // embossed rosettes on a staggered lattice
  h.fillStyle = 'rgb(225,225,225)';
  for (const [x, y] of [
    [64, 64],
    [192, 64],
    [0, 192],
    [128, 192],
    [256, 192],
  ])
    rosette(h, x, y, 40, 8);
  // albedo: gold, tarnished in the hollows
  const { c: mc, ctx: m } = canvas(S, S);
  const hd = h.getImageData(0, 0, S, S).data;
  const img = m.createImageData(S, S);
  const { c: rc, ctx: rx } = canvas(S, S);
  const rimg = rx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const t = hd[i * 4] / 255;
    const n = r();
    const tarn = Math.max(0, 0.5 - t) * 1.4;
    img.data[i * 4] = 236 - tarn * 70 - n * 10;
    img.data[i * 4 + 1] = 186 - tarn * 70 - n * 10;
    img.data[i * 4 + 2] = 98 - tarn * 40 - n * 6;
    img.data[i * 4 + 3] = 255;
    const ro = 0.22 + tarn * 0.4 + n * 0.06;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = Math.min(255, ro * 255);
    rimg.data[i * 4 + 3] = 255;
  }
  m.putImageData(img, 0, 0);
  rx.putImageData(rimg, 0, 0);
  return finish(mc, hc, rc, 2.2, true);
}

/** Lapis-lazuli inlay with pyrite flecks, framed in gold, with gold rosettes. aspect = width / height of the panel. */
export function lapisPanel(aspect: number, rosettes: number): CanvasSet {
  const Hh = 160;
  const W = Math.round(Hh * aspect);
  const r = rnd(31 + rosettes);
  const { c: mc, ctx: m } = canvas(W, Hh);
  const { c: hc, ctx: h } = canvas(W, Hh);
  const { c: rc, ctx: rx } = canvas(W, Hh);
  // lapis: deep ultramarine with lighter veins and gold pyrite specks
  const g = m.createLinearGradient(0, 0, W, Hh);
  g.addColorStop(0, '#1d2f7a');
  g.addColorStop(0.5, '#233a8c');
  g.addColorStop(1, '#1a2a6c');
  m.fillStyle = g;
  m.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 260; i++) {
    m.fillStyle = `rgba(${90 + r() * 60},${120 + r() * 60},${200 + r() * 40},${0.08 + r() * 0.1})`;
    m.beginPath();
    m.ellipse(r() * W, r() * Hh, 4 + r() * 14, 1 + r() * 4, r() * Math.PI, 0, Math.PI * 2);
    m.fill();
  }
  h.fillStyle = 'rgb(110,110,110)';
  h.fillRect(0, 0, W, Hh);
  rx.fillStyle = 'rgb(80,80,80)';
  rx.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 420; i++) {
    const x = r() * W,
      y = r() * Hh,
      s = 0.6 + r() * 1.2;
    m.fillStyle = '#e2b850';
    m.fillRect(x, y, s, s);
    rx.fillStyle = 'rgb(60,60,60)';
    rx.fillRect(x, y, s, s);
  }
  // gold frame and rosettes (raised)
  const f = 12;
  const gold = '#e6b257';
  for (const ctx of [m, h, rx]) {
    ctx.fillStyle = ctx === m ? gold : ctx === h ? 'rgb(200,200,200)' : 'rgb(60,60,60)';
    ctx.fillRect(0, 0, W, f);
    ctx.fillRect(0, Hh - f, W, f);
    ctx.fillRect(0, 0, f, Hh);
    ctx.fillRect(W - f, 0, f, Hh);
    for (let k = 0; k < rosettes; k++) rosette(ctx, ((k + 0.5) / rosettes) * W, Hh / 2, Hh * 0.28, 8);
  }
  // a beaded inner edge of the frame
  for (const ctx of [m, h]) {
    ctx.fillStyle = ctx === m ? '#f0c56a' : 'rgb(230,230,230)';
    for (let x = f + 4; x < W - f; x += 7) {
      for (const y of [f + 3, Hh - f - 3]) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return finish(mc, hc, rc, 2.5, false);
}

/** Red wool canopy: woven texture, darker madder stripes and a yellow / blue border. */
export function canopyCloth(): CanvasSet {
  const S = 256;
  const r = rnd(99);
  const { c: mc, ctx: m } = canvas(S, S);
  const { c: hc, ctx: h } = canvas(S, S);
  const { c: rc, ctx: rx } = canvas(S, S);
  m.fillStyle = '#8f2316';
  m.fillRect(0, 0, S, S);
  h.fillStyle = 'rgb(128,128,128)';
  h.fillRect(0, 0, S, S);
  rx.fillStyle = 'rgb(225,225,225)';
  rx.fillRect(0, 0, S, S);
  // weave
  for (let y = 0; y < S; y += 2) {
    m.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.06})`;
    m.fillRect(0, y, S, 1);
    h.fillStyle = 'rgba(90,90,90,0.5)';
    h.fillRect(0, y, S, 1);
  }
  for (let x = 0; x < S; x += 2) {
    h.fillStyle = 'rgba(160,160,160,0.25)';
    h.fillRect(x, 0, 1, S);
  }
  // borders: yellow band with a blue-white zigzag, a fringe line
  const band = (o: number) => {
    for (const [x, y, w, hh] of [
      [o, o, S - 2 * o, 14],
      [o, S - o - 14, S - 2 * o, 14],
      [o, o, 14, S - 2 * o],
      [S - o - 14, o, 14, S - 2 * o],
    ]) {
      m.fillStyle = '#cf9a35';
      m.fillRect(x, y, w, hh);
      h.fillStyle = 'rgb(150,150,150)';
      h.fillRect(x, y, w, hh);
    }
    m.strokeStyle = '#26407e';
    m.lineWidth = 3;
    m.beginPath();
    for (let x = o; x <= S - o; x += 8) m.lineTo(x, o + ((x / 8) % 2 ? 3 : 11));
    m.stroke();
    m.beginPath();
    for (let x = o; x <= S - o; x += 8) m.lineTo(x, S - o - ((x / 8) % 2 ? 3 : 11));
    m.stroke();
  };
  band(10);
  // a few darker madder stripes in the field
  for (const y of [70, 128, 186]) {
    m.fillStyle = 'rgba(70,10,8,0.35)';
    m.fillRect(30, y, S - 60, 5);
  }
  return finish(mc, hc, rc, 1.2, false);
}
