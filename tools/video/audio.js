// Renders the scene's own procedural soundscape for every shot, offline and in
// lock-step with the camera: the page's AudioContext is replaced by an
// OfflineAudioContext before the app loads, and rendering is suspended at every
// video frame so the simulation (camera, crowd, procession) can advance exactly
// as in render.js. Output: audio/<id>.wav (48 kHz stereo, 16-bit).
//   node audio.js [shotIds]

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { shots, FPS } = require('./shots');
const { PAGE_HELPERS } = require('./page');

const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const URL = 'http://localhost:4173/?q=ultra&cam=-1.4,1.7,92,0,9.5,0';
const SR = 48000;
const PRE = 2.5; // seconds of pre-roll: the engine fades in and the ambient beds settle

fs.mkdirSync(path.join(__dirname, 'audio'), { recursive: true });

async function renderShotAudio(browser, s) {
  const total = PRE + s.dur + 0.5;
  const ctx = await browser.newContext({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ total, SR }) => {
    const off = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
    const realResume = off.resume.bind(off);
    // only the frame scheduler may resume rendering (the app retries resume() on its own)
    off.resume = () => (window.__allowResume ? realResume() : Promise.resolve());
    window.__offline = off;
    const Fake = function () {
      return off;
    };
    window.AudioContext = Fake;
    window.webkitAudioContext = Fake;
  }, { total, SR });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200));
  });
  await page.goto(URL);
  await page.waitForFunction(() => window.app && window.world, null, { timeout: 180000 });
  await page.addScriptTag({ content: PAGE_HELPERS });
  const t0 = Date.now();
  const b64 = await page.evaluate(
    async ([shot, fps, PRE, SR]) => {
      const v = window.__v, exp = window.babylon, app = window.app;
      const N = v.setup(shot, fps);
      const snd = exp.sound;
      snd.setTimeOfDay(shot.time);
      await snd.start();
      snd.setMuted(false);
      const L = exp.listener;
      L._timer.update = () => L._timer;
      L._timer.getDelta = () => 1 / fps;
      const off = window.__offline;
      const preFrames = Math.round(PRE * fps);
      const totalFrames = preFrames + N;
      let k = 0;
      const resume = () => {
        window.__allowResume = true;
        off.resume();
        window.__allowResume = false;
      };
      const onSuspend = () => {
        if (k < preFrames) {
          app.camera.updateMatrixWorld(true);
          snd.update(1 / fps, app.camera.position);
        } else {
          v.frame(k - preFrames);
        }
        k++;
        if (k < totalFrames) off.suspend(k / fps).then(onSuspend);
        resume();
      };
      off.suspend(0).then(onSuspend);
      const buf = await off.startRendering();
      // 16-bit PCM WAV of the shot itself (pre-roll removed)
      const start = Math.round(PRE * SR);
      const len = Math.round((N / fps) * SR);
      const L0 = buf.getChannelData(0), R0 = buf.getChannelData(1);
      const bytes = new Uint8Array(44 + len * 4);
      const dv = new DataView(bytes.buffer);
      const str = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
      str(0, 'RIFF'); dv.setUint32(4, 36 + len * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
      dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
      str(36, 'data'); dv.setUint32(40, len * 4, true);
      let peak = 0;
      for (let i = 0; i < len; i++) {
        const l = L0[start + i] || 0, r = R0[start + i] || 0;
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
        dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l)) * 32767, true);
        dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r)) * 32767, true);
      }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.__peak = peak;
      return btoa(bin);
    },
    [s, FPS, PRE, SR],
  );
  const peak = await page.evaluate(() => window.__peak);
  fs.writeFileSync(path.join(__dirname, 'audio', `${s.id}.wav`), Buffer.from(b64, 'base64'));
  console.log(`${s.id}: audio ${s.dur}s in ${((Date.now() - t0) / 1000).toFixed(1)} s, peak ${peak.toFixed(3)}`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  for (const s of shots.filter((x) => !ONLY || ONLY.includes(x.id))) await renderShotAudio(browser, s);
  await browser.close();
})();
