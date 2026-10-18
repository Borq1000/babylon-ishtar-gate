// Dev-only page: traces relief layer outlines over a CC0 reference photograph
// and previews the generated relief maps. Open /dev/relief.html?a=lion&mode=trace

import { ANIMALS } from '../architecture/reliefs/AnimalShapes';
import { generateRelief, splinePath } from '../architecture/reliefs/ReliefGenerator';
import type { AnimalDef, Pt } from '../architecture/reliefs/ReliefTypes';

const params = new URLSearchParams(location.search);
const name = params.get('a') ?? 'lion';
const mode = params.get('mode') ?? 'trace';
const def: AnimalDef = ANIMALS[name];
const wrap = document.getElementById('wrap')!;

const COLORS = ['#ff4040', '#40ff40', '#4080ff', '#ffff40', '#ff40ff', '#40ffff', '#ff9040', '#ffffff', '#a0ff80', '#ff80c0'];

async function trace() {
  const refUrl = params.get('ref') ?? (def as AnimalDef & { ref?: string }).ref;
  const scale = Number(params.get('scale') ?? '0.9');
  const vx = Number(params.get('vx') ?? '0'), vy = Number(params.get('vy') ?? '0');
  const vw = Number(params.get('vw') ?? String(def.frame.w)), vh = Number(params.get('vh') ?? String(def.frame.h));
  const c = document.createElement('canvas');
  c.width = vw * scale;
  c.height = vh * scale;
  c.style.width = c.width + 'px';
  wrap.appendChild(c);
  const ctx = c.getContext('2d')!;
  if (refUrl) {
    const img = new Image();
    img.src = refUrl;
    await img.decode();
    ctx.globalAlpha = Number(params.get('alpha') ?? '0.85');
    ctx.drawImage(img, vx, vy, vw, vh, 0, 0, c.width, c.height);
    ctx.globalAlpha = 1;
  }
  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '10px monospace';
  const step = Number(params.get('step') ?? '50');
  for (let x = Math.ceil(vx / step) * step; x <= vx + vw; x += step) {
    ctx.beginPath();
    ctx.moveTo((x - vx) * scale, 0);
    ctx.lineTo((x - vx) * scale, c.height);
    ctx.lineWidth = x % (step * 2) === 0 ? 1 : 0.5;
    ctx.stroke();
    if (x % (step * 2) === 0) ctx.fillText(String(x), (x - vx) * scale + 2, 10);
  }
  for (let y = Math.ceil(vy / step) * step; y <= vy + vh; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, (y - vy) * scale);
    ctx.lineTo(c.width, (y - vy) * scale);
    ctx.lineWidth = y % (step * 2) === 0 ? 1 : 0.5;
    ctx.stroke();
    if (y % (step * 2) === 0) ctx.fillText(String(y), 2, (y - vy) * scale - 2);
  }
  if (params.get('grid') === 'only') return;
  const tx = (p: Pt): Pt => [(p[0] - vx) * scale, (p[1] - vy) * scale];
  def.layers.forEach((layer, li) => {
    const col = COLORS[li % COLORS.length];
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    for (const sh of layer.shapes ?? []) {
      const p = new Path2D();
      splinePath(p, sh, true, tx);
      ctx.stroke(p);
      ctx.fillStyle = col;
      for (const pt of sh) ctx.fillRect((pt[0] - vx) * scale - 2, (pt[1] - vy) * scale - 2, 4, 4);
    }
    for (const poly of layer.polys ?? []) {
      ctx.beginPath();
      poly.forEach((pt, i) => (i ? ctx.lineTo((pt[0] - vx) * scale, (pt[1] - vy) * scale) : ctx.moveTo((pt[0] - vx) * scale, (pt[1] - vy) * scale)));
      ctx.closePath();
      ctx.stroke();
    }
    for (const st of layer.strokes ?? []) {
      const p = new Path2D();
      splinePath(p, st.pts, false, tx);
      ctx.lineWidth = st.width * scale;
      ctx.globalAlpha = 0.35;
      ctx.stroke(p);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
    }
    for (const e of layer.ellipses ?? []) {
      ctx.beginPath();
      ctx.ellipse((e[0] - vx) * scale, (e[1] - vy) * scale, e[2] * scale, e[3] * scale, e[4], 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = col;
    const first = layer.shapes?.[0]?.[0] ?? layer.strokes?.[0]?.pts[0] ?? layer.polys?.[0]?.[0];
    if (first) ctx.fillText(layer.id, (first[0] - vx) * scale + 4, (first[1] - vy) * scale - 4);
  });
}

function maps() {
  const t0 = performance.now();
  const m = generateRelief(def, Number(params.get('ppm') ?? '700'));
  const t1 = performance.now();
  const info = document.createElement('div');
  info.textContent = `${name}: ${m.width}x${m.height}px, ${(t1 - t0).toFixed(0)} ms, panel ${m.panelW.toFixed(3)} x ${m.panelH.toFixed(3)} m`;
  wrap.appendChild(info);
  const show = (fn: (o: number) => [number, number, number]) => {
    const c = document.createElement('canvas');
    c.width = m.width;
    c.height = m.height;
    c.style.width = Math.min(1500, m.width) + 'px';
    const z = params.get('zoom');
    if (z) { c.style.width = m.width * Number(z) + 'px'; c.style.imageRendering = 'pixelated'; c.style.marginLeft = -Number(params.get('ox') ?? '0') * Number(z) + 'px'; c.style.marginTop = -Number(params.get('oy') ?? '0') * Number(z) + 'px'; }
    const ctx = c.getContext('2d')!;
    const id = ctx.createImageData(m.width, m.height);
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        const o = ((m.height - 1 - y) * m.width + x) * 4; // texture rows are bottom-up
        const [r, g, b] = fn(o);
        const p = (y * m.width + x) * 4;
        id.data[p] = r;
        id.data[p + 1] = g;
        id.data[p + 2] = b;
        id.data[p + 3] = m.albedo[o + 3] ? 255 : 60;
      }
    ctx.putImageData(id, 0, 0);
    wrap.appendChild(c);
  };
  // raking-light preview
  const L = [-0.55, 0.45, 0.7];
  const ll = Math.hypot(L[0], L[1], L[2]);
  show((o) => {
    const nx = m.normal[o] / 127.5 - 1,
      ny = m.normal[o + 1] / 127.5 - 1,
      nz = m.normal[o + 2] / 127.5 - 1;
    const d = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
    const ao = m.orm[o] / 255;
    const shade = (0.18 * ao + 1.1 * d) * 0.95;
    return [m.albedo[o] * shade, m.albedo[o + 1] * shade, m.albedo[o + 2] * shade];
  });
  if (params.get('all')) {
    show((o) => [m.albedo[o], m.albedo[o + 1], m.albedo[o + 2]]);
    show((o) => [m.orm[o + 3], m.orm[o + 3], m.orm[o + 3]]);
  }
}

if (mode === 'trace') trace();
else maps();
