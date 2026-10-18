import { type AudioEnv, clamp, filterNode, gainNode, oscNode, pluckEnv, releaseOnEnded } from './core';
import { noiseBurst, normalizePeak } from './noise';
import type { Rng } from './rng';

// ---------------------------------------------------------------------------------------------
// Frame drums. The "dum" is the membrane's fundamental: a sine whose pitch drops quickly from
// ~2.3x to its resting value (tension relaxing after the strike), plus a broad band-passed noise
// burst for the skin slap / soft click, which is also what keeps the stroke readable on small
// laptop speakers that cannot reproduce 80 Hz. The "tek" is a rim/edge stroke: band-passed noise
// around 2.5 kHz with a short ~400 Hz ring.
// ---------------------------------------------------------------------------------------------

export function dum(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, vel: number, f0: number): boolean {
  const ctx = env.ctx;
  const end = t + 0.8;
  if (!env.budget.acquire(t, end, 5, 2)) return false;
  const o = oscNode(ctx, 'sine', f0);
  o.frequency.setValueAtTime(f0 * 2.3, t);
  o.frequency.exponentialRampToValueAtTime(f0, t + 0.05);
  const g = gainNode(ctx, 0);
  pluckEnv(g.gain, t, vel * 0.42, 0.003, rng.range(0.11, 0.15));

  const n = noiseBurst(ctx, env.noise.white, rng, t, 0.2);
  const bp = filterNode(ctx, 'bandpass', rng.range(500, 700), 0.7);
  const ng = gainNode(ctx, 0);
  pluckEnv(ng.gain, t, vel * 3.2, 0.001, rng.range(0.025, 0.035));

  o.connect(g).connect(dest);
  n.connect(bp).connect(ng).connect(dest);
  o.start(t);
  o.stop(end);
  releaseOnEnded(o, [o, g, n, bp, ng]);
  return true;
}

export function tek(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, vel: number): boolean {
  const ctx = env.ctx;
  const end = t + 0.25;
  if (!env.budget.acquire(t, end, 5, 2)) return false;
  const n = noiseBurst(ctx, env.noise.white, rng, t, 0.14);
  const bp = filterNode(ctx, 'bandpass', rng.range(2300, 2800), 1.4);
  const ng = gainNode(ctx, 0);
  pluckEnv(ng.gain, t, vel * 2.6, 0.001, rng.range(0.016, 0.024));
  const o = oscNode(ctx, 'sine', rng.range(385, 430));
  const og = gainNode(ctx, 0);
  pluckEnv(og.gain, t, vel * 0.1, 0.002, 0.035);
  n.connect(bp).connect(ng).connect(dest);
  o.connect(og).connect(dest);
  o.start(t);
  o.stop(end);
  releaseOnEnded(o, [n, bp, ng, o, og]);
  return true;
}

/** Large temple drum (cf. the bronze lilissu): deep pitch-dropping sine plus a boomy low-mid skin burst. */
export function bigDrum(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, vel: number): boolean {
  const ctx = env.ctx;
  const end = t + 2.0;
  if (!env.budget.acquire(t, end, 5, 2)) return false;
  const f0 = rng.range(48, 56);
  const o = oscNode(ctx, 'sine', f0);
  o.frequency.setValueAtTime(f0 * 2.2, t);
  o.frequency.exponentialRampToValueAtTime(f0, t + 0.09);
  const g = gainNode(ctx, 0);
  pluckEnv(g.gain, t, vel * 0.6, 0.004, 0.38);
  const n = noiseBurst(ctx, env.noise.white, rng, t, 0.4);
  const bp = filterNode(ctx, 'bandpass', rng.range(160, 210), 0.9);
  const ng = gainNode(ctx, 0);
  pluckEnv(ng.gain, t, vel * 2.5, 0.003, 0.07);
  o.connect(g).connect(dest);
  n.connect(bp).connect(ng).connect(dest);
  o.start(t);
  o.stop(end);
  releaseOnEnded(o, [o, g, n, bp, ng]);
  return true;
}

/**
 * Small thick bronze cymbals clashed together. Metallic body: six square oscillators at
 * inharmonic ratios, band/high-passed (the classic analogue cymbal recipe); a few slowly beating
 * sine partials give the bronze "ring"; a burst of high-passed noise is the clash itself.
 */
export function cymbalClash(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, vel: number): boolean {
  const ctx = env.ctx;
  const dur = rng.range(2.6, 3.6);
  const end = t + dur;
  if (!env.budget.acquire(t, end, 17, 2)) return false;
  const nodes: AudioNode[] = [];
  const base = rng.range(310, 400);

  const metal = gainNode(ctx, 0.12);
  const bp = filterNode(ctx, 'bandpass', rng.range(5200, 7000), 0.8);
  const hp = filterNode(ctx, 'highpass', 2600, 0);
  const metalEnv = gainNode(ctx, 0);
  pluckEnv(metalEnv.gain, t, vel * 0.45, 0.002, dur * 0.2);
  metal.connect(bp).connect(hp).connect(metalEnv).connect(dest);
  nodes.push(metal, bp, hp, metalEnv);
  let longest: OscillatorNode | null = null;
  for (const r of [1, 1.342, 1.783, 2.215, 2.646, 3.187]) {
    const o = oscNode(ctx, 'square', base * r * rng.range(0.99, 1.01));
    o.connect(metal);
    o.start(t);
    o.stop(end);
    nodes.push(o);
    longest = o;
  }

  const ringEnv = gainNode(ctx, 0);
  pluckEnv(ringEnv.gain, t, vel * 0.05, 0.004, dur * 0.3);
  ringEnv.connect(dest);
  nodes.push(ringEnv);
  for (const f of [base * 2.76, base * 2.76 * 1.006, base * 4.13]) {
    const o = oscNode(ctx, 'sine', f);
    o.connect(ringEnv);
    o.start(t);
    o.stop(end);
    nodes.push(o);
  }

  const n = noiseBurst(ctx, env.noise.white, rng, t, 1.2);
  const nhp = filterNode(ctx, 'highpass', 4500, 0);
  const ng = gainNode(ctx, 0);
  pluckEnv(ng.gain, t, vel * 0.7, 0.002, 0.22);
  n.connect(nhp).connect(ng).connect(dest);
  nodes.push(n, nhp, ng);

  if (longest) releaseOnEnded(longest, nodes);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Lyre: Karplus-Strong plucked strings, pre-rendered per scale degree (a DelayNode feedback
// loop cannot go below one 128-sample render quantum, i.e. it cannot reach lyre pitches).
// ---------------------------------------------------------------------------------------------

/** Heptatonic diatonic mode (Dorian-like) in Pythagorean ratios: tuned by fifths and fourths, as
 * the Old Babylonian string-tuning texts describe for the nine-string lyre. */
export const LYRE_SCALE: readonly number[] = [1, 9 / 8, 32 / 27, 4 / 3, 3 / 2, 27 / 16, 16 / 9];

const PLUCK_RATE = 24000;

/**
 * Extended Karplus-Strong: a delay line of one period, initialised with a soft (low-passed) noise
 * burst through a pick-position comb; each pass goes through a two-point average (frequency-
 * dependent damping: highs die first, as on gut strings), a loss factor set from the desired T60,
 * and a first-order allpass for exact fractional tuning.
 */
function renderPluck(ctx: BaseAudioContext, freq: number, rng: Rng): AudioBuffer {
  const sr = PLUCK_RATE;
  const t60 = clamp(2.8 * Math.sqrt(147 / freq), 1.0, 3.2);
  const len = Math.floor(t60 * 0.7 * sr);
  const buffer = ctx.createBuffer(1, len, sr);
  const out = buffer.getChannelData(0);

  const period = sr / freq;
  let delay = Math.floor(period - 0.5);
  let frac = period - 0.5 - delay;
  if (frac < 0.1) {
    delay -= 1;
    frac += 1;
  }
  const c = (1 - frac) / (1 + frac);
  const rho = Math.pow(10, -3 / (t60 * freq));

  const exc = new Float32Array(delay);
  const bright = rng.range(0.35, 0.6);
  let lp = 0;
  for (let i = 0; i < delay; i++) {
    lp += bright * (rng.next() * 2 - 1 - lp);
    exc[i] = lp;
  }
  const pick = Math.max(1, Math.round(delay * rng.range(0.1, 0.18)));
  const line = new Float32Array(delay);
  let mean = 0;
  for (let i = 0; i < delay; i++) {
    line[i] = exc[i]! - 0.9 * exc[(i - pick + delay) % delay]!;
    mean += line[i]!;
  }
  mean /= delay;
  for (let i = 0; i < delay; i++) line[i] = line[i]! - mean;

  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  for (let n = 0; n < len; n++) {
    const x = line[idx]!;
    out[n] = x;
    const avg = rho * 0.5 * (x + prev);
    prev = x;
    const y = c * avg + apX - c * apY;
    apX = avg;
    apY = y;
    line[idx] = y;
    if (++idx >= delay) idx = 0;
  }
  const fade = Math.floor(len * 0.15);
  for (let i = 0; i < fade; i++) {
    const k = len - fade + i;
    out[k] = out[k]! * 0.5 * (1 + Math.cos((Math.PI * i) / fade));
  }
  normalizePeak(out, 0.8);
  return buffer;
}

export class LyreBank {
  readonly tonic: number;
  readonly scale: readonly number[];
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly cache = new Map<number, AudioBuffer>();

  constructor(ctx: BaseAudioContext, rng: Rng, tonic = 146.83, scale: readonly number[] = LYRE_SCALE) {
    this.ctx = ctx;
    this.rng = rng;
    this.tonic = tonic;
    this.scale = scale;
  }

  /** Frequency of a scale degree (0 = tonic, 7 = octave, 4 = fifth ...). */
  freq(degree: number): number {
    const n = this.scale.length;
    const oct = Math.floor(degree / n);
    const ratio = this.scale[((degree % n) + n) % n] ?? 1;
    return this.tonic * Math.pow(2, oct) * ratio;
  }

  /** Rendered lazily (about 1 ms per string) and cached. */
  buffer(degree: number): AudioBuffer {
    let b = this.cache.get(degree);
    if (!b) {
      b = renderPluck(this.ctx, this.freq(degree), this.rng);
      this.cache.set(degree, b);
    }
    return b;
  }

  pluck(env: AudioEnv, t: number, dest: AudioNode, degree: number, vel: number, rng: Rng): boolean {
    const buf = this.buffer(degree);
    if (!env.budget.acquire(t, t + buf.duration, 2, 1)) return false;
    const src = env.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, rng.jitter(4) / 1200); // strings never perfectly in tune
    const g = gainNode(env.ctx, vel);
    src.connect(g).connect(dest);
    src.start(t);
    releaseOnEnded(src, [src, g]);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Footsteps: a bank of pre-rendered sandal-on-brick grains (low-passed heel thump + gritty scuff),
// triggered per walker with random grain / rate / level: two nodes per step.
// ---------------------------------------------------------------------------------------------

function renderStep(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(0.16 * sr);
  const buffer = ctx.createBuffer(1, len, sr);
  const out = buffer.getChannelData(0);
  const heelA = 1 - Math.exp((-2 * Math.PI * rng.range(300, 700)) / sr);
  const heelTau = rng.range(0.012, 0.025) * sr;
  const scrapeStart = Math.floor(rng.range(0.005, 0.04) * sr);
  const scrapeTau = rng.range(0.025, 0.06) * sr;
  const scrapeLevel = rng.range(0.15, 0.4);
  const gLo = 1 - Math.exp((-2 * Math.PI * 1500) / sr);
  const gHi = 1 - Math.exp((-2 * Math.PI * rng.range(3000, 5000)) / sr);
  const toe = rng.chance(0.5) ? Math.floor(rng.range(0.03, 0.06) * sr) : -1;
  let heel = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < len; i++) {
    const w = rng.next() * 2 - 1;
    heel += heelA * (w - heel);
    let s = heel * Math.exp(-i / heelTau);
    if (toe > 0 && i >= toe) s += heel * 0.5 * Math.exp(-(i - toe) / (heelTau * 0.7));
    lo += gLo * (w - lo);
    hi += gHi * (w - hi);
    if (i >= scrapeStart) {
      const k = i - scrapeStart;
      s += (hi - lo) * scrapeLevel * Math.min(1, k / (0.004 * sr)) * Math.exp(-k / scrapeTau);
    }
    out[i] = s;
  }
  const fade = Math.floor(0.02 * sr);
  for (let i = 0; i < fade; i++) out[len - 1 - i] = out[len - 1 - i]! * (i / fade);
  normalizePeak(out, rng.range(0.4, 0.8)); // level variety is baked in: no per-step gain node needed
  return buffer;
}

/**
 * Footstep grains played straight into a caller-provided bus (one node per step). Per-walker
 * loudness comes from which bus the walker uses (near/mid/far), step-to-step variety from the
 * grain choice (each rendered at a different level) and a random playback rate.
 */
export class FootstepBank {
  private readonly grains: AudioBuffer[] = [];

  constructor(ctx: BaseAudioContext, rng: Rng, count = 12) {
    for (let i = 0; i < count; i++) this.grains.push(renderStep(ctx, rng));
  }

  step(env: AudioEnv, t: number, dest: AudioNode, rng: Rng): boolean {
    const buf = rng.pick(this.grains);
    const rate = rng.range(0.85, 1.15);
    if (!env.budget.acquire(t, t + buf.duration / rate, 1, 0)) return false;
    const src = env.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(t);
    releaseOnEnded(src, [src]);
    return true;
  }
}

/** Fired-clay vessel knocked against another: two inharmonic partials with a fast decay. */
export function clayClink(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, vel: number): boolean {
  const ctx = env.ctx;
  const end = t + 0.25;
  if (!env.budget.acquire(t, end, 4, 0)) return false;
  const f = rng.range(1100, 2300);
  const a = oscNode(ctx, 'sine', f);
  const b = oscNode(ctx, 'sine', f * rng.range(2.2, 2.6));
  const ga = gainNode(ctx, 0);
  const gb = gainNode(ctx, 0);
  pluckEnv(ga.gain, t, vel, 0.001, rng.range(0.02, 0.045));
  pluckEnv(gb.gain, t, vel * 0.4, 0.001, 0.015);
  a.connect(ga).connect(dest);
  b.connect(gb).connect(dest);
  a.start(t);
  b.start(t);
  a.stop(end);
  b.stop(end);
  releaseOnEnded(a, [a, b, ga, gb]);
  return true;
}
