import {
  type AudioEnv,
  disconnectAll,
  filterNode,
  gainNode,
  oscNode,
  panNode,
  releaseOnEnded,
  safeStop,
} from './core';
import { loopNoise, noiseBurst } from './noise';
import type { Rng } from './rng';

export interface Vowel {
  readonly f1: number;
  readonly f2: number;
}

/** Adult-male formant centres (Hz): the four Akkadian vowels, plus "o" for chant. */
export const VOWELS = {
  a: { f1: 730, f2: 1150 },
  e: { f1: 500, f2: 1750 },
  i: { f1: 300, f2: 2250 },
  u: { f1: 330, f2: 850 },
  o: { f1: 480, f2: 860 },
} as const satisfies Record<string, Vowel>;

export type VowelKey = keyof typeof VOWELS;

const SPEECH_VOWELS: readonly (readonly [VowelKey, number])[] = [
  ['a', 4],
  ['e', 2],
  ['i', 2.2],
  ['u', 1.6],
];

export interface Speaker {
  /** Mean voice pitch (Hz). */
  readonly pitch: number;
  /** Formant scale (vocal tract length): 1 = adult male. */
  readonly formant: number;
  /** Breathiness 0..1. */
  readonly breath: number;
}

export function randomSpeaker(rng: Rng): Speaker {
  const kind = rng.weighted([
    ['m', 5],
    ['f', 4],
    ['c', 1],
  ] as const);
  if (kind === 'm') return { pitch: rng.range(92, 140), formant: rng.range(0.95, 1.04), breath: rng.range(0.25, 0.6) };
  if (kind === 'f') return { pitch: rng.range(170, 245), formant: rng.range(1.1, 1.2), breath: rng.range(0.35, 0.75) };
  return { pitch: rng.range(240, 320), formant: rng.range(1.22, 1.32), breath: rng.range(0.3, 0.6) };
}

export interface BabbleOptions {
  /** Aspiration source (a shared white-noise loop). */
  readonly noise: AudioNode;
  /** Optional shared high-passed noise for fricative consonants (close voices only). */
  readonly fricative?: AudioNode | null;
  /** Peak syllable gain. */
  readonly level: number;
  /** Far voices use broader, less precise formants. */
  readonly distant: boolean;
}

/**
 * One synthetic talker. Source-filter model: a sawtooth "glottal buzz" plus breath noise excite
 * two parallel band-pass formant filters (F1/F2). Every syllable retargets the formants to a new
 * vowel with a short glide (coarticulation), moves the pitch along a falling phrase contour and
 * shapes the amplitude (consonant closure -> vowel nucleus -> dip). Phrases of 3-12 syllables at
 * 3-6 syllables/s are separated by pauses, and the "speaker" (pitch, vocal tract, breathiness)
 * changes between phrases, so a handful of voices reads as many people taking turns.
 */
export class BabbleVoice {
  readonly output: GainNode;
  /** Called at a phrase start when another "person" takes over (used to re-pan bed voices). */
  onSpeakerChange: ((speaker: Speaker, when: number) => void) | null = null;
  private readonly rng: Rng;
  private readonly level: number;
  private readonly osc: OscillatorNode;
  private readonly buzz: GainNode;
  private readonly breath: GainNode;
  private readonly f1: BiquadFilterNode;
  private readonly f2: BiquadFilterNode;
  private readonly f2Gain: GainNode;
  private readonly fric: GainNode | null;
  private speaker: Speaker;
  private next: number;
  private sylLeft = 0;
  private sylIndex = 0;
  private phraseLen = 1;
  private rate = 4.5;
  private basePitch = 120;
  private question = false;

  constructor(ctx: BaseAudioContext, rng: Rng, opts: BabbleOptions, dest: AudioNode, when: number) {
    this.rng = rng;
    this.level = opts.level;
    this.speaker = randomSpeaker(rng);
    this.osc = oscNode(ctx, 'sawtooth', this.speaker.pitch);
    this.buzz = gainNode(ctx, 1);
    this.breath = gainNode(ctx, this.speaker.breath * 2);
    this.f1 = filterNode(ctx, 'bandpass', 600, opts.distant ? 4.5 : 6.5);
    this.f2 = filterNode(ctx, 'bandpass', 1400, opts.distant ? 6 : 9);
    this.f2Gain = gainNode(ctx, 0.55);
    this.output = gainNode(ctx, 0);

    this.osc.connect(this.buzz);
    this.buzz.connect(this.f1);
    this.buzz.connect(this.f2);
    opts.noise.connect(this.breath);
    this.breath.connect(this.f1);
    this.breath.connect(this.f2);
    this.f1.connect(this.output);
    this.f2.connect(this.f2Gain).connect(this.output);
    this.output.connect(dest);
    if (opts.fricative) {
      this.fric = gainNode(ctx, 0);
      opts.fricative.connect(this.fric);
      this.fric.connect(dest);
    } else {
      this.fric = null;
    }
    this.osc.start(when);
    this.next = when + rng.range(0.1, 2.5);
  }

  /** Schedule syllables up to `horizon`. `activity` (0..1) controls how talkative the voice is. */
  schedule(now: number, horizon: number, activity: number): void {
    if (this.next < now - 0.3) this.next = now + this.rng.range(0.05, 0.6); // resync after a stall
    while (this.next < horizon) {
      const t = Math.max(this.next, now + 0.005);
      if (this.sylLeft <= 0 && !this.beginPhrase(t, activity)) {
        this.next = t + this.rng.range(1.2, 4.5);
        continue;
      }
      this.next = t + this.syllable(t);
    }
  }

  stop(when: number): void {
    safeStop(this.osc, when);
  }

  disconnect(): void {
    disconnectAll([this.osc, this.buzz, this.breath, this.f1, this.f2, this.f2Gain, this.output, this.fric]);
  }

  private beginPhrase(t: number, activity: number): boolean {
    const rng = this.rng;
    if (!rng.chance(0.2 + 0.75 * activity)) return false;
    if (rng.chance(0.4)) {
      this.speaker = randomSpeaker(rng);
      this.breath.gain.setTargetAtTime(this.speaker.breath * 2, t, 0.03);
      this.onSpeakerChange?.(this.speaker, t);
    }
    this.phraseLen = rng.int(3, 12);
    this.sylLeft = this.phraseLen;
    this.sylIndex = 0;
    this.rate = rng.range(3, 6);
    this.basePitch = this.speaker.pitch * rng.range(0.92, 1.1);
    this.question = rng.chance(0.15);
    return true;
  }

  /** Schedules one syllable at `t`; returns the time until the next event (incl. pauses). */
  private syllable(t: number): number {
    const rng = this.rng;
    const last = this.sylLeft === 1;
    const progress = this.phraseLen > 1 ? this.sylIndex / (this.phraseLen - 1) : 0;
    const stressed = rng.chance(this.sylIndex === 0 ? 0.5 : 0.22);
    const d = (rng.range(0.75, 1.3) / this.rate) * (last ? 1.35 : 1); // phrase-final lengthening

    const v = VOWELS[rng.weighted(SPEECH_VOWELS)];
    const fs = this.speaker.formant * rng.range(0.95, 1.05);
    this.f1.frequency.setTargetAtTime(v.f1 * fs, t, 0.025);
    this.f2.frequency.setTargetAtTime(v.f2 * fs, t, 0.03);

    // Intonation: declination over the phrase, pitch accents, final fall (or rise for a question).
    const p = this.basePitch * (1.08 - 0.2 * progress) * (stressed ? 1.13 : 1) * rng.range(0.97, 1.03);
    const f = this.osc.frequency;
    f.setTargetAtTime(p, t, 0.035);
    f.setTargetAtTime(p * (last ? (this.question ? 1.25 : 0.85) : 0.96), t + d * 0.45, d * 0.35);

    // Amplitude: consonant closure, vowel nucleus, then a dip (or silence at the phrase end).
    const amp = this.level * (stressed ? 1 : rng.range(0.5, 0.8));
    const closure = rng.range(0.012, 0.05);
    const g = this.output.gain;
    g.setTargetAtTime(amp * 0.06, t, 0.01);
    g.setTargetAtTime(amp, t + closure, 0.018);
    g.setTargetAtTime(last ? 0 : amp * 0.22, t + d * (last ? 0.85 : 0.7), last ? 0.05 : 0.022);

    if (this.fric && rng.chance(0.3)) {
      // sibilant/fricative onset ("s", "sh", "h") inside the closure gap
      const fg = this.fric.gain;
      fg.setTargetAtTime(amp * 0.12, t, 0.004);
      fg.setTargetAtTime(0, t + closure + 0.015, 0.01);
    }

    this.sylIndex++;
    this.sylLeft--;
    if (!last) return d;
    // Pause after the phrase: mostly a breath, sometimes listening to someone else.
    return d + (rng.chance(0.25) ? rng.range(1.5, 4) : rng.range(0.25, 0.9));
  }
}

/**
 * Distant city murmur: several babble voices, each at its own stereo position, summed and
 * low-passed so consonants and upper formants vanish as they do over distance and around walls;
 * a quiet band-passed noise "wash" glues them into a crowd. Occasional distant calls rise above.
 */
export class MurmurBed {
  readonly output: GainNode;
  private readonly env: AudioEnv;
  private readonly rng: Rng;
  private readonly noise: AudioBufferSourceNode;
  private readonly washSrc: AudioBufferSourceNode;
  private readonly washGain: GainNode;
  private readonly callBus: GainNode;
  private readonly voices: BabbleVoice[] = [];
  private readonly nodes: AudioNode[] = [];
  private nextCall: number;
  private nextWash: number;

  constructor(env: AudioEnv, rng: Rng, dest: AudioNode, voiceCount = 5) {
    const ctx = env.ctx;
    const now = ctx.currentTime;
    this.env = env;
    this.rng = rng;
    this.output = gainNode(ctx, 1);
    const sum = gainNode(ctx, 1);
    const hp = filterNode(ctx, 'highpass', 140, 0);
    const lp = filterNode(ctx, 'lowpass', 1150, 0);
    sum.connect(hp).connect(lp).connect(this.output);
    this.output.connect(dest);

    this.noise = loopNoise(ctx, env.noise.white, rng, now);
    for (let i = 0; i < voiceCount; i++) {
      const pan = panNode(ctx, rng.range(-0.85, 0.85));
      const voice = new BabbleVoice(ctx, rng.fork(i), { noise: this.noise, level: 0.5, distant: true }, pan, now);
      voice.onSpeakerChange = (_s, when) => pan.pan.setTargetAtTime(rng.range(-0.9, 0.9), when, 0.05);
      pan.connect(sum);
      this.voices.push(voice);
      this.nodes.push(pan);
    }

    this.washSrc = loopNoise(ctx, env.noise.pink, rng, now);
    const washBp = filterNode(ctx, 'bandpass', 480, 0.9);
    this.washGain = gainNode(ctx, 0.1);
    this.washSrc.connect(washBp).connect(this.washGain).connect(sum);

    this.callBus = gainNode(ctx, 1);
    const callLp = filterNode(ctx, 'lowpass', 1900, 0);
    this.callBus.connect(callLp).connect(this.output);

    this.nodes.push(sum, hp, lp, washBp, this.washGain, this.callBus, callLp);
    this.nextCall = now + rng.range(4, 10);
    this.nextWash = now;
  }

  schedule(now: number, horizon: number, activity: number): void {
    for (const v of this.voices) v.schedule(now, horizon, activity);
    const rng = this.rng;
    if (this.nextWash < horizon) {
      const t = Math.max(this.nextWash, now);
      this.washGain.gain.setTargetAtTime(rng.range(0.06, 0.16) * (0.35 + 0.65 * activity), t, 1.5);
      this.nextWash = t + rng.range(2, 5);
    }
    if (this.nextCall < horizon) {
      const t = Math.max(this.nextCall, now + 0.02);
      if (activity > 0.05) distantCall(this.env, t, this.callBus, rng, 0.55 * Math.sqrt(activity));
      this.nextCall = t + 2 + rng.exp(9 / Math.max(0.15, activity));
    }
  }

  dispose(): void {
    const when = this.env.ctx.currentTime;
    for (const v of this.voices) {
      v.stop(when);
      v.disconnect();
    }
    safeStop(this.noise, when);
    safeStop(this.washSrc, when);
    disconnectAll([this.noise, this.washSrc, ...this.nodes, this.output]);
  }
}

/**
 * A merchant's or herald's cry far away: 1-3 short syllables, then a long open vowel that swells
 * with vibrato and sags in pitch. Same source-filter voice as the babble, as a one-shot.
 */
export function distantCall(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const syl = rng.int(1, 3);
  const sylDur = rng.range(0.15, 0.24);
  const hold = rng.range(0.6, 1.5);
  const dur = syl * sylDur + hold + 0.5;
  if (!env.budget.acquire(t, t + dur, 10, 0)) return false;
  const female = rng.chance(0.3);
  const p = female ? rng.range(270, 350) : rng.range(160, 230);
  const fs = female ? 1.15 : 1;

  const osc = oscNode(ctx, 'sawtooth', p);
  const vib = oscNode(ctx, 'sine', rng.range(4.8, 6));
  const vibDepth = gainNode(ctx, 0);
  const noise = noiseBurst(ctx, env.noise.white, rng, t, dur);
  const breath = gainNode(ctx, 0.9);
  const f1 = filterNode(ctx, 'bandpass', 700 * fs, 5);
  const f2 = filterNode(ctx, 'bandpass', 1200 * fs, 7);
  const f2g = gainNode(ctx, 0.5);
  const amp = gainNode(ctx, 0);
  const pan = panNode(ctx, rng.range(-0.95, 0.95));
  vib.connect(vibDepth).connect(osc.frequency);
  osc.connect(f1);
  osc.connect(f2);
  noise.connect(breath);
  breath.connect(f1);
  breath.connect(f2);
  f1.connect(amp);
  f2.connect(f2g).connect(amp);
  amp.connect(pan).connect(dest);

  const g = amp.gain;
  const fr = osc.frequency;
  let tt = t;
  g.setValueAtTime(0, t);
  for (let i = 0; i < syl; i++) {
    const v = VOWELS[rng.weighted(SPEECH_VOWELS)];
    f1.frequency.setTargetAtTime(v.f1 * fs, tt, 0.02);
    f2.frequency.setTargetAtTime(v.f2 * fs, tt, 0.02);
    fr.setTargetAtTime(p * (1 + 0.06 * i), tt, 0.03);
    g.setTargetAtTime(level * 0.55, tt + 0.02, 0.02);
    g.setTargetAtTime(level * 0.12, tt + sylDur * 0.75, 0.02);
    tt += sylDur;
  }
  // The long carrying vowel: open "a"/"o"; the pitch lifts, then sags while vibrato blooms.
  const v = VOWELS[rng.chance(0.65) ? 'a' : 'o'];
  f1.frequency.setTargetAtTime(v.f1 * fs, tt, 0.04);
  f2.frequency.setTargetAtTime(v.f2 * fs, tt, 0.04);
  fr.setTargetAtTime(p * rng.range(1.08, 1.2), tt, 0.06);
  fr.setTargetAtTime(p * rng.range(0.85, 0.95), tt + hold * 0.6, hold * 0.3);
  g.setTargetAtTime(level, tt, hold * 0.15);
  g.setTargetAtTime(0, tt + hold * 0.7, hold * 0.18);
  vibDepth.gain.setValueAtTime(0, tt);
  vibDepth.gain.linearRampToValueAtTime(p * 0.02, tt + hold * 0.6);

  osc.start(t);
  vib.start(t);
  osc.stop(t + dur);
  vib.stop(t + dur);
  releaseOnEnded(osc, [osc, vib, vibDepth, noise, breath, f1, f2, f2g, amp, pan]);
  return true;
}

/**
 * Laughter: 4-9 short pulses at ~5 Hz, each a breathy "h" onset followed by a voiced "a"/"e",
 * with falling pitch and decaying strength over the burst.
 */
export function laughBurst(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const pulses = rng.int(4, 9);
  const rate = rng.range(4.2, 6);
  const dur = pulses / rate + 0.3;
  if (!env.budget.acquire(t, t + dur, 8, 1)) return false;
  const female = rng.chance(0.5);
  const p0 = female ? rng.range(240, 330) : rng.range(140, 200);
  const fs = female ? 1.15 : 1;

  const osc = oscNode(ctx, 'sawtooth', p0);
  const noise = noiseBurst(ctx, env.noise.white, rng, t, dur);
  const buzz = gainNode(ctx, 0);
  const breath = gainNode(ctx, 0);
  const f1 = filterNode(ctx, 'bandpass', 800 * fs, 5);
  const f2 = filterNode(ctx, 'bandpass', rng.pick([1250, 1650]) * fs, 7);
  const f2g = gainNode(ctx, 0.6);
  const amp = gainNode(ctx, level);
  osc.connect(buzz);
  noise.connect(breath);
  buzz.connect(f1);
  buzz.connect(f2);
  breath.connect(f1);
  breath.connect(f2);
  f1.connect(amp);
  f2.connect(f2g).connect(amp);
  amp.connect(dest);

  osc.frequency.setValueAtTime(p0 * 1.15, t);
  osc.frequency.exponentialRampToValueAtTime(p0 * 0.8, t + pulses / rate);
  for (let i = 0; i < pulses; i++) {
    const tp = t + i / rate + Math.abs(rng.jitter(0.012));
    const a = Math.pow(0.86, i) * rng.range(0.8, 1);
    breath.gain.setTargetAtTime(a * 2.5, tp, 0.006);
    breath.gain.setTargetAtTime(a * 0.3, tp + 0.03, 0.015);
    buzz.gain.setTargetAtTime(a, tp + 0.02, 0.008);
    buzz.gain.setTargetAtTime(0, tp + 0.02 + 0.45 / rate, 0.012);
  }
  breath.gain.setTargetAtTime(0, t + pulses / rate, 0.03);

  osc.start(t);
  osc.stop(t + dur);
  releaseOnEnded(osc, [osc, noise, buzz, breath, f1, f2, f2g, amp]);
  return true;
}

/**
 * Processional chant: a few low male voices sustaining "oh" -> "ah" -> "oh" on the tonic (sometimes
 * with the fifth of the lower octave), slightly detuned against each other, swelling in and out.
 */
export function chantSwell(
  env: AudioEnv,
  t: number,
  dest: AudioNode,
  rng: Rng,
  tonic: number,
  duration: number,
  level: number,
): boolean {
  const ctx = env.ctx;
  const withFifth = rng.chance(0.45);
  const n = withFifth ? 4 : 3;
  const end = t + duration + 0.5;
  if (!env.budget.acquire(t, end, n + 7, 1)) return false;

  const exc = gainNode(ctx, 1 / n);
  const vib = oscNode(ctx, 'sine', rng.range(4.6, 5.6));
  const vibDepth = gainNode(ctx, tonic * 0.006);
  vib.connect(vibDepth);
  const oscs: OscillatorNode[] = [];
  for (let i = 0; i < n; i++) {
    const fifth = withFifth && i === n - 1;
    const f = (fifth ? tonic * 0.75 : tonic) * Math.pow(2, rng.jitter(9) / 1200);
    const o = oscNode(ctx, 'sawtooth', f);
    vibDepth.connect(o.frequency);
    o.connect(exc);
    oscs.push(o);
  }
  const f1 = filterNode(ctx, 'bandpass', VOWELS.o.f1, 4);
  const f2 = filterNode(ctx, 'bandpass', VOWELS.o.f2, 6);
  const f2g = gainNode(ctx, 0.5);
  const amp = gainNode(ctx, 0);
  exc.connect(f1);
  exc.connect(f2);
  f1.connect(amp);
  f2.connect(f2g).connect(amp);
  amp.connect(dest);

  const mid = t + duration * rng.range(0.35, 0.55);
  f1.frequency.setTargetAtTime(VOWELS.a.f1, mid - 0.6, 0.5);
  f2.frequency.setTargetAtTime(VOWELS.a.f2, mid - 0.6, 0.5);
  f1.frequency.setTargetAtTime(VOWELS.o.f1, mid + duration * 0.25, 0.8);
  f2.frequency.setTargetAtTime(VOWELS.o.f2, mid + duration * 0.25, 0.8);
  amp.gain.setValueAtTime(0, t);
  amp.gain.setTargetAtTime(level, t, duration * 0.12);
  amp.gain.setTargetAtTime(0, t + duration * 0.62, duration * 0.12);

  vib.start(t);
  vib.stop(end);
  for (const o of oscs) {
    o.start(t);
    o.stop(end);
  }
  releaseOnEnded(vib, [...oscs, vib, vibDepth, exc, f1, f2, f2g, amp]);
  return true;
}

/** Goat/sheep bleat ("meh-eh-eh") for market clusters: buzzy voice with fast tremolo, e -> a glide. */
export function bleat(env: AudioEnv, t: number, dest: AudioNode, rng: Rng, level: number): boolean {
  const ctx = env.ctx;
  const dur = rng.range(0.45, 0.9);
  const end = t + dur + 0.15;
  if (!env.budget.acquire(t, end, 8, 0)) return false;
  const p = rng.range(300, 480);
  const osc = oscNode(ctx, 'sawtooth', p);
  const trem = oscNode(ctx, 'sine', rng.range(6.5, 9));
  const tremDepth = gainNode(ctx, 0.45);
  const am = gainNode(ctx, 0.55);
  const f1 = filterNode(ctx, 'bandpass', 600, 5);
  const f2 = filterNode(ctx, 'bandpass', 1900, 8);
  const f2g = gainNode(ctx, 0.6);
  const amp = gainNode(ctx, 0);
  trem.connect(tremDepth).connect(am.gain);
  osc.connect(am);
  am.connect(f1);
  am.connect(f2);
  f1.connect(amp);
  f2.connect(f2g).connect(amp);
  amp.connect(dest);

  f1.frequency.setTargetAtTime(880, t + dur * 0.4, dur * 0.3);
  f2.frequency.setTargetAtTime(1500, t + dur * 0.4, dur * 0.3);
  osc.frequency.setValueAtTime(p, t);
  osc.frequency.linearRampToValueAtTime(p * 1.06, t + dur * 0.3);
  osc.frequency.linearRampToValueAtTime(p * 0.9, t + dur);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.05);
  amp.gain.setTargetAtTime(level * 0.6, t + 0.1, dur * 0.4);
  amp.gain.setTargetAtTime(0, t + dur * 0.8, 0.05);

  osc.start(t);
  trem.start(t);
  osc.stop(end);
  trem.stop(end);
  releaseOnEnded(osc, [osc, trem, tremDepth, am, f1, f2, f2g, amp]);
  return true;
}
