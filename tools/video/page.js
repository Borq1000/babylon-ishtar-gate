// Code injected into the app page: deterministic camera paths, captions and the
// title / end cards. Exposes window.__v.

const PAGE_HELPERS = String.raw`
(function () {
  const app = window.app, exp = window.babylon, crowd = window.world.crowd;
  const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (kind, t) => {
    if (kind === 'linear') return t;
    const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
    return 0.45 * t + 0.55 * s; // eased but never fully stopped at the cut
  };
  // Catmull-Rom through key values, keys at normalised times
  function spline(keys, field, u) {
    const n = keys.length;
    if (n === 1) return keys[0][field].slice();
    let i = 0;
    while (i < n - 2 && u > keys[i + 1].t) i++;
    const k1 = keys[i], k2 = keys[i + 1];
    const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(n - 1, i + 2)];
    const t = Math.min(1, Math.max(0, (u - k1.t) / Math.max(1e-6, k2.t - k1.t)));
    const out = [];
    const len = k1[field].length;
    for (let c = 0; c < len; c++) {
      const p0 = k0[field][c], p1 = k1[field][c], p2 = k2[field][c], p3 = k3[field][c];
      const t2 = t * t, t3 = t2 * t;
      out.push(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
    }
    return out;
  }
  const num = (keys, f, u) => {
    const n = keys.length;
    let i = 0;
    while (i < n - 2 && u > keys[i + 1].t) i++;
    const a = keys[i], b = keys[Math.min(n - 1, i + 1)];
    const t = Math.min(1, Math.max(0, (u - a.t) / Math.max(1e-6, b.t - a.t)));
    return lerp(a[f] ?? 42, b[f] ?? a[f] ?? 42, t);
  };

  // ------------------------------------------------------------ overlay
  const css = document.createElement('style');
  css.textContent = [
    '#vov{position:fixed;inset:0;pointer-events:none;z-index:60;font-family:"Inter Variable",Inter,sans-serif;color:#efe6d4}',
    '#vov .shade{position:absolute;left:0;bottom:0;width:62%;height:46%;background:radial-gradient(ellipse at 0% 100%,rgba(5,6,10,.62) 0%,rgba(5,6,10,.32) 38%,rgba(5,6,10,0) 70%)}',
    '#vov .cap{position:absolute;left:112px;bottom:104px;max-width:900px}',
    '#vov .eb{font-size:15px;letter-spacing:.36em;text-transform:uppercase;color:#dcb56c;margin-bottom:14px;font-weight:500}',
    '#vov .ti{font-family:"Cormorant Garamond",serif;font-weight:300;font-size:64px;line-height:1.02;letter-spacing:.02em}',
    '#vov .rule{width:72px;height:1px;background:linear-gradient(90deg,#dcb56c,rgba(220,181,108,0));margin:18px 0 14px}',
    '#vov .su{font-size:19px;letter-spacing:.02em;color:rgba(239,230,212,.82);font-weight:350}',
    '#vov .card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}',
    '#vov .cardshade{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,rgba(5,6,10,.45) 0%,rgba(5,6,10,.15) 45%,rgba(5,6,10,0) 75%)}',
    '#vov .big{position:relative;font-family:"Cormorant Garamond",serif;font-weight:300;font-size:168px;letter-spacing:.34em;margin-right:-.34em;line-height:1}',
    '#vov .crule{position:relative;width:120px;height:1px;background:linear-gradient(90deg,rgba(220,181,108,0),#dcb56c,rgba(220,181,108,0));margin:34px 0 26px}',
    '#vov .small{position:relative;font-size:21px;letter-spacing:.42em;margin-right:-.42em;text-transform:uppercase;color:rgba(239,230,212,.9)}',
    '#vov .tiny{position:relative;font-size:17px;letter-spacing:.18em;color:rgba(239,230,212,.72);margin-top:16px}',
    '#vov .gold{color:#dcb56c}',
  ].join('\n');
  document.head.appendChild(css);
  const el = (tag, cls, text, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  };
  const root = el('div', null, undefined, document.body);
  root.id = 'vov';
  const shade = el('div', 'shade', undefined, root);
  const cap = el('div', 'cap', undefined, root);
  const eb = el('div', 'eb', '', cap);
  const ti = el('div', 'ti', '', cap);
  const rule = el('div', 'rule', undefined, cap);
  const su = el('div', 'su', '', cap);
  const title = el('div', 'card', undefined, root);
  el('div', 'cardshade', undefined, title);
  el('div', 'big', 'BABYLON', title);
  el('div', 'crule', undefined, title);
  el('div', 'small', 'The Ishtar Gate · 575 BCE', title);
  const end = el('div', 'card', undefined, root);
  el('div', 'cardshade', undefined, end);
  el('div', 'big', 'BABYLON', end);
  el('div', 'crule', undefined, end);
  el('div', 'small', 'A real-time reconstruction', end);
  el('div', 'tiny', 'three.js · WebGL 2 · runs in the browser', end);
  el('div', 'tiny gold', 'github.com/Borq1000/babylon-ishtar-gate', end);
  [shade, cap, title, end].forEach((e) => (e.style.opacity = '0'));

  const fade = (t, a, b, fi, fo) => Math.max(0, Math.min(1, (t - a) / fi, (b - t) / fo));

  const v = {
    shot: null,
    N: 0,
    setup(shot, fps) {
      this.shot = shot;
      this.fps = fps;
      this.N = Math.round(shot.dur * fps);
      const ui = document.getElementById('ui');
      if (ui) ui.style.display = 'none';
      app.paused = true;
      app.dynRes.enabled = false;
      app.dynRes.scale = 1;
      app.resize();
      exp.setTime(shot.time, true);
      if (shot.proc !== undefined) crowd.setProcessionHead(shot.proc);
      crowd.cameraClearance = 4;
      const c = shot.caption;
      eb.textContent = c ? c.eyebrow : '';
      ti.textContent = c ? c.title : '';
      su.textContent = c ? c.sub : '';
      rule.style.display = c && c.sub ? 'block' : 'none';
      eb.style.display = c && c.eyebrow ? 'block' : 'none';
      this.place(0);
      const warm = Math.round((shot.warm || 2) * fps);
      for (let i = 0; i < warm; i++) {
        this.place(0);
        app.step(1 / fps);
      }
      // the procession must not have moved during the warm-up of tracked shots
      if (shot.proc !== undefined && shot.track) crowd.setProcessionHead(shot.proc);
      return this.N;
    },
    subject() {
      const s = this.shot;
      if (s.track === 'pal') {
        const p = crowd.palanquin.position;
        return [p.x, 0, p.z];
      }
      if (s.track === 'head') return [0, 0, crowd.processionZ];
      return [0, 0, 0];
    },
    place(i) {
      const s = this.shot;
      const t = this.N > 1 ? i / (this.N - 1) : 0;
      const u = ease(s.ease, t);
      let pos, look, fov;
      if (s.orbit) {
        const o = s.orbit;
        const a = (lerp(o.a0, o.a1, u) * Math.PI) / 180;
        pos = [o.center[0] + Math.sin(a) * o.radius, o.height, o.center[2] + Math.cos(a) * o.radius];
        look = o.look;
        fov = o.fov || 40;
      } else {
        pos = spline(s.keys, 'pos', u);
        look = spline(s.keys, 'look', u);
        fov = num(s.keys, 'fov', u);
        if (s.track) {
          const b = this.subject();
          pos = [pos[0] + b[0], pos[1], pos[2] + b[2]];
          look = [look[0] + b[0], look[1], look[2] + b[2]];
        }
      }
      app.camera.fov = fov;
      app.camera.updateProjectionMatrix();
      app.camera.position.set(pos[0], pos[1], pos[2]);
      app.camera.lookAt(look[0], look[1], look[2]);
    },
    overlay(i) {
      const s = this.shot;
      const time = i / this.fps;
      const c = s.caption;
      const capA = c ? fade(time, 0.9, s.dur - 1.7, 0.8, 0.8) : 0;
      cap.style.opacity = String(capA);
      cap.style.transform = 'translateY(' + ((1 - Math.min(1, (time - 0.9) / 0.8)) * 10).toFixed(2) + 'px)';
      shade.style.opacity = String(capA * (c && c.sub ? 1 : 0.7));
      title.style.opacity = String(s.overlay === 'title' ? fade(time, 1.6, s.dur - 1.9, 1.4, 1.2) : 0);
      end.style.opacity = String(s.overlay === 'end' ? fade(time, 1.4, s.dur + 10, 1.6, 1) : 0);
    },
    frame(i) {
      // tracked subjects move 2.4 cm per frame during the step: a one-frame lag is invisible
      this.place(i);
      this.overlay(i);
      app.step(1 / this.fps);
    },
    sync() {
      const gl = app.renderer.getContext();
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    },
  };
  window.__v = v;
})();
`;

module.exports = { PAGE_HELPERS };
