import { type AudioEnv, clamp, disconnectAll, filterNode, gainNode } from './core';
import { bigDrum, cymbalClash, dum, type FootstepBank, type LyreBank, tek } from './instruments';
import type { Rng } from './rng';
import { chantSwell } from './voices';

/**
 * 8-step cycles (eighth notes at 66-72 BPM). D = dum, d = soft dum, T = accented tek, t = tek,
 * . = rest. Cells in the family of the old Near-Eastern frame-drum rhythms (maqsum/baladi/saidi),
 * plus a plain walking pattern. The fourth bar of each 4-bar phrase uses a busier fill.
 */
const PATTERNS: readonly string[] = ['DT.TD.T.', 'DD.TD.T.', 'DT.DD.T.', 'D.t.D.tt', 'D..tD.t.'];
const FILLS: readonly string[] = ['DtTtDtTt', 'D.ttD.TT', 'DT.TdtTt', 'DdtTD.TT'];

const WALKERS = 12;

interface Walker {
  next: number;
  period: number;
  /** index into the near/mid/far step buses */
  bus: number;
}

/** Step bus levels: walkers near the musicians, in the middle of the column, at its far end. */
const STEP_BUS_GAINS: readonly number[] = [0.13, 0.085, 0.05];

/**
 * Everything the procession emits, mixed into one mono `input` that the host engine feeds to a
 * moving PositionalAudio: frame drums with a lilissu-like big drum on phrase starts and rare
 * bronze cymbals at phrase ends, an improvising Karplus-Strong lyre, ~12 shuffling walkers and an
 * occasional low male chant. All of it runs on one look-ahead clock.
 */
export class ProcessionEngine {
  readonly input: GainNode;
  private readonly env: AudioEnv;
  private readonly rng: Rng;
  private readonly lyre: LyreBank;
  private readonly steps: FootstepBank;
  private readonly drumBus: GainNode;
  private readonly lyreBus: GainNode;
  private readonly stepBuses: GainNode[];
  private readonly chantBus: GainNode;
  private readonly nodes: AudioNode[];
  private readonly walkers: Walker[] = [];

  private bpm: number;
  private stepIndex = 0;
  private bar = 0;
  private nextStep: number;
  private pattern: string;
  private fill: string;
  private readonly drumF0: number;
  private lastCymbal = -1e9;

  private lyreNext: number;
  private notesLeft = 0;
  private degree = 7;
  private goal = 7;
  private chantNext: number;

  constructor(env: AudioEnv, rng: Rng, lyre: LyreBank, steps: FootstepBank) {
    const ctx = env.ctx;
    const now = ctx.currentTime;
    this.env = env;
    this.rng = rng;
    this.lyre = lyre;
    this.steps = steps;

    this.input = gainNode(ctx, 1);
    this.drumBus = gainNode(ctx, 1);
    this.drumBus.connect(this.input);
    // lyre body: a gentle low-mid resonance and a soft top (gut strings, wooden sound box)
    this.lyreBus = gainNode(ctx, 1.1);
    const body = filterNode(ctx, 'peaking', 230, 1.2);
    body.gain.value = 4;
    const top = filterNode(ctx, 'lowpass', 4500, 0);
    this.lyreBus.connect(body).connect(top).connect(this.input);
    const stepLp = filterNode(ctx, 'lowpass', 2600, 0);
    stepLp.connect(this.input);
    this.stepBuses = STEP_BUS_GAINS.map((g) => {
      const bus = gainNode(ctx, g);
      bus.connect(stepLp);
      return bus;
    });
    this.chantBus = gainNode(ctx, 1);
    this.chantBus.connect(this.input);
    this.nodes = [this.input, this.drumBus, this.lyreBus, body, top, stepLp, ...this.stepBuses, this.chantBus];

    this.bpm = rng.range(67, 71);
    this.pattern = rng.pick(PATTERNS);
    this.fill = rng.pick(FILLS);
    this.drumF0 = rng.range(76, 88);
    this.nextStep = now + 0.1;
    this.lyreNext = now + rng.range(2, 5);
    this.chantNext = now + rng.range(8, 20);
    for (let i = 0; i < WALKERS; i++) {
      this.walkers.push({ next: now + rng.range(0, 0.6), period: 1 / rng.range(1.6, 1.9), bus: i % STEP_BUS_GAINS.length });
    }
  }

  /**
   * @param intensity combined layer level x active fade (0..1); thins the music as it fades.
   * @param walk 0..1 how much the column is moving (standing crowds only shuffle).
   * @param audible false when culled or muted: clocks keep running, but no nodes are created.
   */
  schedule(now: number, horizon: number, intensity: number, walk: number, audible: boolean): void {
    const play = audible && intensity > 0.02;
    this.scheduleDrums(now, horizon, play);
    this.scheduleLyre(now, horizon, play && intensity > 0.25);
    this.scheduleSteps(now, horizon, play ? Math.round(WALKERS * clamp(intensity * 1.2, 0, 1) * (0.25 + 0.75 * walk)) : 0);
    if (this.chantNext < now - 1) this.chantNext = now + this.rng.range(5, 15);
    if (this.chantNext < horizon) {
      const t = Math.max(this.chantNext, now + 0.02);
      if (play && intensity > 0.3) chantSwell(this.env, t, this.chantBus, this.rng, this.lyre.tonic, this.rng.range(7, 12), 0.16);
      this.chantNext = t + this.rng.range(18, 40);
    }
  }

  dispose(): void {
    disconnectAll(this.nodes);
  }

  private stepDur(): number {
    return 60 / this.bpm / 2;
  }

  private scheduleDrums(now: number, horizon: number, play: boolean): void {
    if (this.nextStep < now - 0.5) this.nextStep = now + 0.05; // resync after a stall
    while (this.nextStep < horizon) {
      if (play) this.playStep(Math.max(this.nextStep, now + 0.005));
      this.advance();
      this.nextStep += this.stepDur();
    }
  }

  private playStep(t: number): void {
    const { env, rng } = this;
    const pat = this.bar === 3 ? this.fill : this.pattern;
    const ch = pat.charAt(this.stepIndex);
    const tt = t + clamp(rng.gauss() * 0.004, -0.01, 0.01); // humanised timing, about ±10 ms
    if (this.bar === 0 && this.stepIndex === 0 && rng.chance(0.8)) {
      bigDrum(env, tt, this.drumBus, rng, rng.range(0.75, 0.95));
    }
    if (ch === 'D' || ch === 'd') {
      const accent = this.stepIndex === 0 ? 1 : ch === 'D' ? 0.85 : 0.55;
      dum(env, tt, this.drumBus, rng, accent * rng.range(0.82, 1), this.drumF0 * rng.range(0.98, 1.02));
      if (ch === 'D' && rng.chance(0.3)) {
        // a second drummer, a hair late and tuned a little higher
        dum(env, tt + rng.range(0.008, 0.022), this.drumBus, rng, accent * 0.5, this.drumF0 * 1.07);
      }
    } else if (ch === 'T' || ch === 't') {
      tek(env, tt, this.drumBus, rng, (ch === 'T' ? 0.8 : 0.55) * rng.range(0.8, 1.05));
    } else if (rng.chance(0.06)) {
      tek(env, tt, this.drumBus, rng, 0.25); // ghost note
    }
    if (this.bar === 3 && this.stepIndex === 6 && t - this.lastCymbal > 24 && rng.chance(0.3)) {
      if (cymbalClash(env, tt, this.drumBus, rng, rng.range(0.6, 0.85))) this.lastCymbal = t;
    }
  }

  private advance(): void {
    const rng = this.rng;
    if (++this.stepIndex < 8) return;
    this.stepIndex = 0;
    if (++this.bar < 4) return;
    this.bar = 0;
    if (rng.chance(0.35)) this.pattern = rng.pick(PATTERNS);
    this.fill = rng.pick(FILLS);
    this.bpm = clamp(this.bpm + rng.jitter(1.5), 66, 72);
  }

  private scheduleLyre(now: number, horizon: number, play: boolean): void {
    if (this.lyreNext < now - 1) this.lyreNext = now + this.rng.range(1, 3);
    while (this.lyreNext < horizon) {
      const t = Math.max(this.lyreNext, now + 0.01);
      if (!play) {
        this.notesLeft = 0;
        this.lyreNext = t + this.rng.range(2, 5);
        continue;
      }
      this.lyreNext = t + this.lyreNote(t);
    }
  }

  /**
   * Sparse, slow improvisation on the heptatonic lyre scale: phrases of 3-9 notes, mostly stepwise
   * with occasional leaps, often opening over a soft open-string drone (tonic + fifth), with dyads
   * of fourths/fifths/thirds and grace notes, cadencing on the octave or the fifth. Rhythm follows
   * the drum grid loosely (rubato). Returns the time until the next note.
   */
  private lyreNote(t: number): number {
    const { env, rng, lyre } = this;
    const bus = this.lyreBus;
    if (this.notesLeft <= 0) {
      this.notesLeft = rng.int(3, 9);
      this.goal = rng.pick([4, 7, 7, 11]);
      this.degree = rng.pick([4, 7, 7, 9, 11]);
      if (rng.chance(0.6)) {
        lyre.pluck(env, t, bus, 0, 0.22, rng);
        lyre.pluck(env, t + rng.range(0.03, 0.08), bus, 4, 0.16, rng);
      }
    }
    const last = this.notesLeft === 1;
    let deg = this.degree;
    if (last) {
      deg = this.goal;
    } else {
      deg += rng.weighted([
        [-1, 3],
        [1, 3],
        [-2, 1.5],
        [2, 1.5],
        [0, 0.6],
        [-3, 0.5],
        [3, 0.5],
        [4, 0.4],
        [-4, 0.4],
      ] as const);
      if (this.notesLeft <= 3) deg += Math.sign(this.goal - deg);
      deg = clamp(deg, 2, 13);
    }
    this.degree = deg;

    const vel = rng.range(0.28, 0.42) * (last ? 1.1 : 1);
    const tt = t + rng.jitter(0.025);
    if (!last && rng.chance(0.15)) lyre.pluck(env, tt - 0.07, bus, deg + 1, vel * 0.5, rng);
    lyre.pluck(env, tt, bus, deg, vel, rng);
    if (rng.chance(last ? 0.5 : 0.25)) {
      lyre.pluck(env, tt + rng.range(0.005, 0.03), bus, Math.max(0, deg - rng.pick([2, 3, 4])), vel * 0.7, rng);
    }
    this.notesLeft--;
    const beats = last ? rng.pick([4, 6, 8]) : rng.pick([1, 1, 2, 2, 2, 3, 4]);
    return beats * this.stepDur() + (last ? rng.range(3, 9) : 0);
  }

  /** ~1.6-1.9 steps/s per walker with timing jitter and occasional changes of pace. */
  private scheduleSteps(now: number, horizon: number, activeWalkers: number): void {
    const { env, rng } = this;
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i]!;
      if (w.next < now - 0.5) w.next = now + rng.range(0, w.period);
      while (w.next < horizon) {
        const t = Math.max(w.next, now + 0.005);
        if (i < activeWalkers) this.steps.step(env, t, this.stepBuses[w.bus]!, rng);
        if (rng.chance(0.02)) w.period = 1 / rng.range(1.6, 1.9);
        w.next = t + w.period * rng.range(0.96, 1.04) + rng.gauss() * 0.008;
      }
    }
  }
}
