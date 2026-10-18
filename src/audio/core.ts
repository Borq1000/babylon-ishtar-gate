import type { NoiseBank } from './noise';

export type TimeOfDayKey = 'morning' | 'midday' | 'golden' | 'night';

/** Mix layers. Each has its own bus whose gain follows the time-of-day table. */
export type LayerKey =
  | 'wind'
  | 'murmur'
  | 'crowd'
  | 'procession'
  | 'birds'
  | 'owl'
  | 'crickets'
  | 'fire'
  | 'water';

export const LAYER_KEYS: readonly LayerKey[] = [
  'wind',
  'murmur',
  'crowd',
  'procession',
  'birds',
  'owl',
  'crickets',
  'fire',
  'water',
];

/** Event priority for the voice budget: 0 = texture (birds, steps), 1 = normal, 2 = rhythm/music. */
export type Priority = 0 | 1 | 2;

/**
 * Bounds the number of simultaneously sounding one-shot nodes. Every event declares how many
 * nodes it creates and its [start, end] interval; it is admitted only if the nodes of all events
 * overlapping that interval plus its own stay under the cap. Low-priority events may only use
 * part of the budget, so drums and music are never starved by birdsong or footsteps.
 */
export class VoiceBudget {
  readonly limit: number;
  /** Events refused so far, per priority (diagnostics). */
  readonly dropped: [number, number, number] = [0, 0, 0];
  private readonly ctx: BaseAudioContext;
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly costs: number[] = [];

  constructor(ctx: BaseAudioContext, limit: number) {
    this.ctx = ctx;
    this.limit = limit;
  }

  /** Nodes of events sounding right now. */
  get active(): number {
    const now = this.purge();
    let n = 0;
    for (let i = 0; i < this.ends.length; i++) if ((this.starts[i] as number) <= now) n += this.costs[i] as number;
    return n;
  }

  acquire(start: number, end: number, cost: number, priority: Priority = 1): boolean {
    this.purge();
    let used = 0;
    for (let i = 0; i < this.ends.length; i++) {
      if ((this.starts[i] as number) < end && (this.ends[i] as number) > start) used += this.costs[i] as number;
    }
    // texture may fill ~60% of the budget, normal events ~80%; the rest is kept for rhythm/music
    const cap = priority === 2 ? this.limit : priority === 1 ? this.limit * 0.8 : this.limit * 0.6;
    if (used + cost > cap) {
      this.dropped[priority]++;
      return false;
    }
    this.starts.push(start);
    this.ends.push(end);
    this.costs.push(cost);
    return true;
  }

  private purge(): number {
    const now = this.ctx.currentTime;
    let w = 0;
    for (let i = 0; i < this.ends.length; i++) {
      const end = this.ends[i] as number;
      if (end <= now) continue;
      this.starts[w] = this.starts[i] as number;
      this.ends[w] = end;
      this.costs[w] = this.costs[i] as number;
      w++;
    }
    this.starts.length = w;
    this.ends.length = w;
    this.costs.length = w;
    return now;
  }
}

/** Shared services handed to every generator. */
export interface AudioEnv {
  readonly ctx: AudioContext;
  readonly noise: NoiseBank;
  readonly budget: VoiceBudget;
  /** Smoothed 0..1 level of a layer (mirrors the audio-rate crossfade); used to thin out events. */
  level(layer: LayerKey): number;
  /** Current wind strength 0..1. */
  readonly wind: number;
}

/** Look-ahead window for the event scheduler (seconds). */
export const LOOKAHEAD = 0.2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Note: for lowpass/highpass Web Audio interprets Q in dB (0 = no resonance peak). */
export function filterNode(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

export function oscNode(ctx: BaseAudioContext, type: OscillatorType, frequency: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = frequency;
  return o;
}

export function panNode(ctx: BaseAudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  return p;
}

/** Move a param from wherever it is now toward `target` (time constant `tau`), cancelling pending automation. */
export function glide(param: AudioParam, target: number, now: number, tau: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.setTargetAtTime(target, now, Math.max(tau, 0.001));
}

/** Linear fade from the current value to `target` over `duration` seconds. */
export function fadeTo(param: AudioParam, target: number, now: number, duration: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + Math.max(duration, 0.001));
}

/** Linear attack to `peak`, then exponential decay (time constant `tau`). */
export function pluckEnv(param: AudioParam, t: number, peak: number, attack: number, tau: number): void {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
}

/** Disconnect every node of a one-shot voice once its (longest-running) source has ended. */
export function releaseOnEnded(src: AudioScheduledSourceNode, nodes: readonly AudioNode[]): void {
  src.onended = () => {
    for (const n of nodes) n.disconnect();
  };
}

export function safeStop(src: AudioScheduledSourceNode, when?: number): void {
  try {
    src.stop(when);
  } catch {
    /* never started or already stopped */
  }
}

export function disconnectAll(nodes: readonly (AudioNode | null | undefined)[]): void {
  for (const n of nodes) n?.disconnect();
}
