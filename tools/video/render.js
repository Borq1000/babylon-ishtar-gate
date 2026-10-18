// Renders the presentation shots with headless Chrome on the GPU.
//   node render.js stills [shotIds]   -> stills/<id>_{0,1,2}.jpg (first / middle / last frame)
//   node render.js video  [shotIds]   -> clips/<id>.mp4 (1920x1080, 30 fps, high-quality H.264)
// Every shot loads the page fresh, so all shots are deterministic and independent.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { shots, OVERLAP, FPS } = require('./shots');
const { PAGE_HELPERS } = require('./page');

const MODE = process.argv[2] || 'stills';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const URL = 'http://localhost:4173/?q=ultra&cam=-1.4,1.7,92,0,9.5,0';
const DPR = 1.5; // render 2880x1620, screenshots downscaled to 1920x1080 (supersampling)

fs.mkdirSync(path.join(__dirname, 'stills'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'clips'), { recursive: true });

async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200));
  });
  await page.goto(URL);
  await page.waitForFunction(() => window.app && window.world, null, { timeout: 180000 });
  await page.addScriptTag({ content: PAGE_HELPERS });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('300 64px "Cormorant Garamond"'),
      document.fonts.load('400 20px "Inter Variable"'),
    ]);
  });
  return { ctx, page };
}

function shotFrames(s) {
  // each shot but the last carries OVERLAP seconds of handle for the dissolve
  return Math.round(s.dur * FPS);
}

async function renderShot(browser, s) {
  const { ctx, page } = await openPage(browser);
  const N = await page.evaluate(([shot, fps]) => window.__v.setup(shot, fps), [s, FPS]);
  const t0 = Date.now();
  if (MODE === 'stills') {
    const picks = [0, Math.floor(N / 2), N - 1];
    let k = 0;
    for (let i = 0; i < N; i++) {
      await page.evaluate((i) => window.__v.frame(i), i);
      if (picks.includes(i)) {
        await page.evaluate(() => window.__v.sync());
        await page.screenshot({ path: path.join(__dirname, 'stills', `${s.id}_${k++}.jpg`), type: 'jpeg', quality: 88, scale: 'css' });
      }
    }
  } else {
    const final = path.join(__dirname, 'clips', `${s.id}.mp4`);
    const out = path.join(__dirname, 'clips', `${s.id}.tmp.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res) => ff.on('close', res));
    for (let i = 0; i < N; i++) {
      await page.evaluate((i) => { window.__v.frame(i); window.__v.sync(); }, i);
      const buf = await page.screenshot({ type: 'jpeg', quality: 95, scale: 'css' });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 60 === 0) process.stdout.write(`  ${s.id} ${i}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    }
    ff.stdin.end();
    await done;
    fs.renameSync(out, final);
  }
  console.log(`${s.id}: ${N} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  // resumable: finished clips are skipped
  const list = shots.filter((s) => (!ONLY || ONLY.includes(s.id)) && !(MODE === 'video' && fs.existsSync(path.join(__dirname, 'clips', `${s.id}.mp4`))));
  for (const s of list) await renderShot(browser, s);
  await browser.close();
  void shotFrames;
  void OVERLAP;
})();
