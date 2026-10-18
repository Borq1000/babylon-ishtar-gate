// Joins the rendered clips and their audio into the final film:
// 1-second dissolves (video xfade + audio acrossfade), fade in/out, loudness
// normalisation, H.264 High / AAC, faststart.
//   node assemble.js [out.mp4] [height]

const { spawnSync } = require('child_process');
const path = require('path');
const { shots, OVERLAP } = require('./shots');

const out = process.argv[2] || path.join(__dirname, 'babylon-presentation-1080p.mp4');
const height = Number(process.argv[3] || 1080);
const crf = process.argv[4] || '18';
const D = OVERLAP;
const n = shots.length;
const args = ['-y', '-loglevel', 'error'];
for (const s of shots) args.push('-i', path.join(__dirname, 'clips', `${s.id}.mp4`));
for (const s of shots) args.push('-i', path.join(__dirname, 'audio', `${s.id}.wav`));

const f = [];
let acc = shots[0].dur;
let vPrev = '0:v';
let aPrev = `${n}:a`;
for (let k = 1; k < n; k++) {
  const offset = (acc - D).toFixed(3);
  const vOut = k === n - 1 ? 'vx' : `v${k}`;
  const aOut = k === n - 1 ? 'ax' : `a${k}`;
  f.push(`[${vPrev}][${k}:v]xfade=transition=fade:duration=${D}:offset=${offset}[${vOut}]`);
  f.push(`[${aPrev}][${n + k}:a]acrossfade=d=${D}:c1=tri:c2=tri[${aOut}]`);
  vPrev = vOut;
  aPrev = aOut;
  acc = acc + shots[k].dur - D;
}
const T = acc;
// screenshots are full-range BT.601 JPEG: convert to the standard limited-range BT.709 video
const size = height !== 1080 ? `w=-2:h=${height}:` : '';
f.push(`[vx]fade=t=in:st=0:d=1.4,fade=t=out:st=${(T - 2.2).toFixed(3)}:d=2.2,scale=${size}flags=lanczos:in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709[vout]`);
f.push(`[ax]afade=t=in:st=0:d=1.8,afade=t=out:st=${(T - 2.8).toFixed(3)}:d=2.8,loudnorm=I=-18:TP=-1.5:LRA=11,aresample=48000[aout]`);

args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]');
args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-profile:v', 'high', '-level', '4.1', '-r', '30');
args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
args.push('-c:a', 'aac', '-b:a', height >= 1080 ? '192k' : '128k', '-movflags', '+faststart', out);
console.log(`total ${T.toFixed(2)} s, ${n} shots -> ${out}`);
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
