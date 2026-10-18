import {
  type AudioEnv,
  clamp,
  disconnectAll,
  filterNode,
  gainNode,
  glide,
  oscNode,
  panNode,
  pluckEnv,
  releaseOnEnded,
  safeStop,
} from './core';
import { noiseBurst, normalizePeak, stereoNoise } from './noise';
import type { Rng } from './rng';

/**
 * Stereo wind bed. Decorrelated brown noise (L/R) through a low-pass = the body; pink noise through
 * a broad band-pass = the "whoosh"; a narrow resonant band-pass on the same pink = faint whistling
 * around corners at strong wind; a high-passed layer = barely audible air. Gusts are scheduled
 * events that swell gains and open filter cutoffs, then relax; their size and rate follow the
 * wind strength. Gust automation lives on dedicated gain nodes so `setStrength` never cancels it.
 */
export class WindBed {
  readonly output: GainNode;
  private readonly env: AudioEnv;
  private readonly rng: Rng;
  private readonly sources: AudioBufferSourceNode[];
  private readonly nodes: AudioNode[];
  private readonly body: BiquadFilterNode;
  private readonly bodyGust: GainNode;
  private readonly band: BiquadFilterNode;
  private readonly bandGust: GainNode;
  private readonly whistle: BiquadFilterNode;
  private readonly whistleGain: GainNode;
  private readonly airGain: GainNode;
  private strength: number;
  private nextGust: number;

  constructor(env: AudioEnv, rng: Rng, dest: AudioNode, strength: number) {
    const ctx = env.ctx;
    const now = ctx.currentTime;
    this.env = env;
    this.rng = rng;
    this.strength = clamp(strength, 0, 1);
    this.output = gainNode(ctx, this.baseLevel());
    this.output.connect(dest);

    const brown = stereoNoise(ctx, env.noise.brown, rng, now);
    const pink = stereoNoise(ctx, env.noise.pink, rng, now);
    this.body = filterNode(ctx, 'lowpass', this.bodyCut(), 0);
    this.bodyGust = gainNode(ctx, 0.15);
    brown.output.connect(this.body).connect(this.bodyGust).connect(this.output);

    this.band = filterNode(ctx, 'bandpass', 650, 0.9);
    this.bandGust = gainNode(ctx, 0.15);
    pink.output.connect(this.band).connect(this.bandGust).connect(this.output);

    this.whistle = filterNode(ctx, 'bandpass', 900, 14);
    this.whistleGain = gainNode(ctx, 0);
    pink.output.connect(this.whistle).connect(this.whistleGain).connect(this.output);

    const air = filterNode(ctx, 'highpass', 4500, 0);
    this.airGain = gainNode(ctx, 0.06);
    pink.output.connect(air).connect(this.airGain).connect(this.output);

    this.sources = [...brown.sources, ...pink.sources];
    this.nodes = [brown.output, pink.output, this.body, this.bodyGust, this.band, this.bandGust];
    this.nodes.push(this.whistle, this.whistleGain, air, this.airGain, this.output);
    this.nextGust = now + rng.range(0.5, 3);
  }

  setStrength(strength: number, now: number): void {
    this.strength = clamp(strength, 0, 1);
    glide(this.output.gain, this.baseLevel(), now, 1.5);
  }

  schedule(now: number, horizon: number): void {
    if (this.nextGust < now - 1) this.nextGust = now;
    if (this.nextGust >= horizon) return;
    const rng = this.rng;
    const s = this.strength;
    const t = Math.max(this.nextGust, now + 0.01);
    const g = rng.range(0.4, 1) * (0.3 + 0.7 * s);
    const rise = rng.range(0.8, 2.5);
    const fall = rng.range(1.5, 4.5);
    const tauUp = rise / 3;
    const tauDown = fall / 3;
    const top = t + rise;

    this.bodyGust.gain.setTargetAtTime(0.15 * (1 + 1.6 * g), t, tauUp);
    this.bodyGust.gain.setTargetAtTime(0.15 * rng.range(0.85, 1.1), top, tauDown);
    this.body.frequency.setTargetAtTime(this.bodyCut() + 350 * g, t, tauUp);
    this.body.frequency.setTargetAtTime(this.bodyCut(), top, tauDown);

    const center = rng.range(450, 900);
    this.bandGust.gain.setTargetAtTime(0.15 * (1 + 2 * g), t, tauUp);
    this.bandGust.gain.setTargetAtTime(0.15 * rng.range(0.8, 1.1), top, tauDown);
    this.band.frequency.setTargetAtTime(center * (1 + 0.6 * g), t, tauUp);
    this.band.frequency.setTargetAtTime(center, top, tauDown);

    this.whistle.frequency.setTargetAtTime(rng.range(700, 1300), t, rise / 2);
    this.whistleGain.gain.setTargetAtTime(0.4 * s * s * g, t, tauUp);
    this.whistleGain.gain.setTargetAtTime(0, top, tauDown);

    this.airGain.gain.setTargetAtTime(0.06 * (1 + 1.5 * g), t, tauUp);
    this.airGain.gain.setTargetAtTime(0.06, top, tauDown);

    this.nextGust = t + rng.range(2, 6) + (1 - s) * rng.range(2, 8);
  }

  dispose(): void {
    const when = this.env.ctx.currentTime;
    for (const s of this.sources) safeStop(s, when);
    disconnectAll([...this.sources, ...this.nodes]);
  }

  private baseLevel(): number {
    return 0.25 + 0.95 * this.strength;
  }

  private bodyCut(): number {
    return 240 + 260 * this.strength;
  }
}

interface Cricket {
  readonly osc: OscillatorNode;
  readonly lfo: OscillatorNode;
  readonly chirp: GainNode;
  readonly pulses: number;
  readonly pulseRate: number;
  readonly level: number;
  readonly trill: boolean;
  next: number;
}

/**
 * Night insects. Each cricket is a sine carrier (~4-5 kHz) amplitude-modulated by a square LFO at
 * its pulse rate (~30 Hz), gated into chirps of 3-5 pulses by scheduled gain automation; slightly
 * detuned instances sit at fixed stereo positions. One instance is a softer, lower tree-cricket
 * that trills for seconds at a time.
 */
export class CricketChorus {
  readonly output: GainNode;
  private readonly env: AudioEnv;
  private readonly rng: Rng;
  private readonly crickets: Cricket[] = [];
  private readonly nodes: AudioNode[] = [];

  constructor(env: AudioEnv, rng: Rng, dest: AudioNode, count = 4) {
    const ctx = env.ctx;
    const now = ctx.currentTime;
    this.env = env;
    this.rng = rng;
    this.output = gainNode(ctx, 1);
    this.output.connect(dest);
    for (let i = 0; i < count; i++) {
      const trill = i === count - 1;
      const pulseRate = trill ? rng.range(40, 50) : rng.range(26, 38);
      const osc = oscNode(ctx, 'sine', trill ? rng.range(2700, 3200) : rng.range(4200, 5000));
      const lfo = oscNode(ctx, 'square', pulseRate);
      const depth = gainNode(ctx, 0.5);
      const pulse = gainNode(ctx, 0.5);
      const chirp = gainNode(ctx, 0);
      const pan = panNode(ctx, rng.range(-0.85, 0.85));
      lfo.connect(depth).connect(pulse.gain);
      osc.connect(pulse).connect(chirp).connect(pan).connect(this.output);
      osc.start(now);
      lfo.start(now);
      this.crickets.push({
        osc,
        lfo,
        chirp,
        pulses: rng.int(3, 5),
        pulseRate,
        level: trill ? rng.range(0.03, 0.05) : rng.range(0.05, 0.09),
        trill,
        next: now + rng.range(0, 2),
      });
      this.nodes.push(depth, pulse, chirp, pan);
    }
  }

  schedule(now: number, horizon: number, activity: number): void {
    const rng = this.rng;
    for (const c of this.crickets) {
      if (c.next < now - 0.5) c.next = now + rng.range(0, 0.3);
      while (c.next < horizon) {
        const t = Math.max(c.next, now + 0.005);
        if (!rng.chance(0.25 + 0.75 * activity) || rng.chance(0.04)) {
          c.next = t + rng.range(1.5, 6); // a pause in the song
          continue;
        }
        const len = c.trill ? rng.range(1.2, 3.5) : c.pulses / c.pulseRate;
        const g = c.chirp.gain;
        g.setTargetAtTime(c.level * rng.range(0.8, 1), t, c.trill ? 0.08 : 0.004);
        g.setTargetAtTime(0, t + len, c.trill ? 0.12 : 0.006);
        c.next = t + len + (c.trill ? rng.range(0.6, 2.5) : rng.range(0.25, 0.55));
      }
    }
  }

  dispose(): void {
    const when = this.env.ctx.currentTime;
    for (const c of this.crickets) {
      safeStop(c.osc, when);
      safeStop(c.lfo, when);
      disconnectAll([c.osc, c.lfo]);
    }
    disconnectAll([...this.nodes, this.output]);
  }
}

// ---------------------------------------------------------------------------------------------
// Birds. All one-shots with tiny graphs (2-5 nodes); levels are peak gains at refDistance.
// ---------------------------------------------------------------------------------------------

/** Swift/swallow: a trill of rapid downward FM sweeps between ~7 and ~3 kHz, buzzy from a fast FM. */
export function swiftTrill(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const chirps = rng.int(4, 11);
  const lens: number[] = [];
  let dur = 0;
  for (let i = 0; i < chirps; i++) {
    const len = rng.range(0.035, 0.08);
    lens.push(len);
    dur += len + rng.range(0.02, 0.06);
  }
  const end = t + dur + 0.1;
  if (!env.budget.acquire(t, end, 4, 0)) return false;
  const car = oscNode(ctx, 'sine', 5000);
  const mod = oscNode(ctx, 'sine', rng.range(30, 70));
  const modDepth = gainNode(ctx, rng.range(300, 900));
  const g = gainNode(ctx, 0);
  mod.connect(modDepth).connect(car.frequency);
  car.connect(g).connect(dest);
  let tc = t;
  const up = rng.chance(0.25);
  for (const len of lens) {
    const hi = rng.range(5500, 7000);
    const lo = rng.range(3000, 4200);
    car.frequency.setValueAtTime(up ? lo : hi, tc);
    car.frequency.exponentialRampToValueAtTime(up ? hi : lo, tc + len);
    const a = level * rng.range(0.6, 1);
    g.gain.setValueAtTime(0, tc);
    g.gain.linearRampToValueAtTime(a, tc + 0.006);
    g.gain.setTargetAtTime(0, tc + len * 0.6, len * 0.25);
    tc += len + rng.range(0.02, 0.06);
  }
  car.start(t);
  mod.start(t);
  car.stop(end);
  mod.stop(end);
  releaseOnEnded(car, [car, mod, modDepth, g]);
  return true;
}

/** Collared/laughing dove: soft hollow "hoo-HOO-hoo" around 380-560 Hz, gentle attacks, throaty AM. */
export function doveCoo(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const laughing = rng.chance(0.35);
  const notes = laughing ? [0.14, 0.14, 0.2, 0.2, 0.32] : [0.24, rng.range(0.42, 0.55), 0.3];
  let dur = 0;
  for (const d of notes) dur += d + 0.12;
  const end = t + dur + 0.2;
  if (!env.budget.acquire(t, end, 5, 0)) return false;
  const f = rng.range(380, 560);
  const osc = oscNode(ctx, 'sine', f);
  const am = gainNode(ctx, 0.75);
  const lfo = oscNode(ctx, 'sine', rng.range(18, 30));
  const lfoDepth = gainNode(ctx, 0.25);
  const g = gainNode(ctx, 0);
  lfo.connect(lfoDepth).connect(am.gain);
  osc.connect(am).connect(g).connect(dest);
  let tn = t;
  notes.forEach((d, i) => {
    const emph = laughing ? 1 - i * 0.08 : i === 1 ? 1 : 0.7;
    osc.frequency.setValueAtTime(f * 0.94, tn);
    osc.frequency.linearRampToValueAtTime(f * 1.04, tn + d * 0.35);
    osc.frequency.linearRampToValueAtTime(f * 0.96, tn + d);
    g.gain.setTargetAtTime(level * emph, tn, 0.03);
    g.gain.setTargetAtTime(0, tn + d * 0.75, 0.035);
    tn += d + rng.range(0.08, 0.15);
  });
  osc.start(t);
  lfo.start(t);
  osc.stop(end);
  lfo.stop(end);
  releaseOnEnded(osc, [osc, am, lfo, lfoDepth, g]);
  return true;
}

/** House sparrow chatter: irregular short "cheep/chirrup" notes, 2.5-5 kHz, quick up-down contour. */
export function sparrowChatter(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const n = rng.int(3, 10);
  const times: number[] = [];
  let tc = t;
  for (let i = 0; i < n; i++) {
    times.push(tc);
    tc += rng.range(0.04, 0.09) + rng.range(0.05, 0.25);
  }
  const end = tc + 0.15;
  if (!env.budget.acquire(t, end, 2, 0)) return false;
  const osc = oscNode(ctx, 'triangle', 3500);
  const g = gainNode(ctx, 0);
  osc.connect(g).connect(dest);
  const base = rng.range(2600, 3800);
  for (const ts of times) {
    const len = rng.range(0.04, 0.09);
    const f0 = base * rng.range(0.9, 1.25);
    osc.frequency.setValueAtTime(f0, ts);
    osc.frequency.linearRampToValueAtTime(f0 * rng.range(1.2, 1.45), ts + len * 0.3);
    osc.frequency.linearRampToValueAtTime(f0 * rng.range(0.85, 0.95), ts + len);
    g.gain.setValueAtTime(0, ts);
    g.gain.linearRampToValueAtTime(level * rng.range(0.5, 1), ts + 0.004);
    g.gain.setTargetAtTime(0, ts + len * 0.6, len * 0.2);
  }
  osc.start(t);
  osc.stop(end);
  releaseOnEnded(osc, [osc, g]);
  return true;
}

/** Distant owl: hollow "hoo ... hoo-hoo" near 350 Hz with slight bends, placed far to one side. */
export function owlHoot(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const notes: [number, number][] = [
    [0, rng.range(0.3, 0.42)],
    [rng.range(0.6, 0.9), 0.18],
    [0, rng.range(0.4, 0.6)],
  ];
  const end = t + 2.6;
  if (!env.budget.acquire(t, end, 3, 0)) return false;
  const f = rng.range(320, 400);
  const osc = oscNode(ctx, 'sine', f);
  const g = gainNode(ctx, 0);
  const pan = panNode(ctx, rng.range(-0.9, 0.9));
  osc.connect(g).connect(pan).connect(dest);
  let tn = t;
  for (const [gap, d] of notes) {
    tn += gap;
    osc.frequency.setValueAtTime(f * 0.97, tn);
    osc.frequency.linearRampToValueAtTime(f * 1.02, tn + d * 0.3);
    osc.frequency.linearRampToValueAtTime(f * 0.93, tn + d);
    g.gain.setTargetAtTime(level, tn, 0.04);
    g.gain.setTargetAtTime(0, tn + d * 0.7, 0.05);
    tn += d + 0.08;
  }
  osc.start(t);
  osc.stop(end);
  releaseOnEnded(osc, [osc, g, pan]);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Fire and water helpers.
// ---------------------------------------------------------------------------------------------

/**
 * Pre-rendered crackle loop for torches/braziers: a clustered Poisson process of tiny decaying noise
 * impulses (many small ticks, few loud pops, occasional resin "snaps" with a short resonant ring),
 * written modulo the length so the loop is seamless. Rendered at 22.05 kHz to save memory.
 */
export function renderCrackle(ctx: BaseAudioContext, rng: Rng, seconds = 9): AudioBuffer {
  const sr = 22050;
  const n = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(1, n, sr);
  const d = buffer.getChannelData(0);
  let t = 0;
  let busy = false;
  while (t < seconds) {
    if (rng.chance(busy ? 0.08 : 0.04)) busy = !busy;
    t += rng.exp(busy ? 0.025 : 0.11);
    const start = Math.floor(t * sr);
    const amp = Math.pow(rng.next(), 2.4);
    const tau = rng.range(0.0003, 0.0025) * sr;
    const span = Math.floor(tau * 5);
    for (let i = 0; i < span; i++) {
      const k = (start + i) % n;
      d[k] = d[k]! + amp * (rng.next() * 2 - 1) * Math.exp(-i / tau);
    }
    if (amp > 0.5 && rng.chance(0.35)) {
      const f = rng.range(1500, 3500);
      const ring = Math.floor(0.02 * sr);
      for (let i = 0; i < ring; i++) {
        const k = (start + i) % n;
        d[k] = d[k]! + amp * 0.4 * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (0.004 * sr));
      }
    }
  }
  // gentle one-pole high-pass to remove thumps (the roar layer supplies the lows)
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < n; i++) {
    const x = d[i]!;
    prevOut = 0.97 * (prevOut + x - prevIn);
    prevIn = x;
    d[i] = prevOut;
  }
  normalizePeak(d, 0.9);
  return buffer;
}

/** A louder resin pop: short band-passed noise burst with an instantaneous attack. */
export function fireSnap(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const end = t + 0.12;
  if (!env.budget.acquire(t, end, 3, 0)) return false;
  const n = noiseBurst(ctx, env.noise.white, rng, t, 0.1);
  const bp = filterNode(ctx, 'bandpass', rng.range(1800, 3500), 1);
  const g = gainNode(ctx, 0);
  pluckEnv(g.gain, t, level, 0.0005, rng.range(0.004, 0.009));
  n.connect(bp).connect(g).connect(dest);
  releaseOnEnded(n, [n, bp, g]);
  return true;
}

/** Water bubble / "plip": a sine whose pitch rises quickly as the bubble resonance collapses. */
export function bubble(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const len = rng.range(0.03, 0.07);
  const end = t + len + 0.05;
  if (!env.budget.acquire(t, end, 2, 0)) return false;
  const f = rng.range(450, 1300);
  const osc = oscNode(ctx, 'sine', f);
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(f * rng.range(1.4, 2), t + len);
  const g = gainNode(ctx, 0);
  pluckEnv(g.gain, t, level, 0.002, len * 0.35);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(end);
  releaseOnEnded(osc, [osc, g]);
  return true;
}
