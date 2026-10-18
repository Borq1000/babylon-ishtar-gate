import * as THREE from 'three';
import {
  type AudioEnv,
  type LayerKey,
  clamp,
  disconnectAll,
  filterNode,
  gainNode,
  glide,
  safeStop,
  smoothstep,
} from './core';
import { clayClink } from './instruments';
import { bubble, doveCoo, fireSnap, sparrowChatter, swiftTrill } from './nature';
import { loopNoise } from './noise';
import type { Rng } from './rng';
import { BabbleVoice, bleat, laughBurst } from './voices';

export type EmitterKind = 'crowd' | 'fire' | 'bird' | 'water';

export const EMITTER_KINDS: readonly EmitterKind[] = ['crowd', 'fire', 'bird', 'water'];

export interface EmitterSpec {
  readonly layer: LayerKey;
  readonly refDistance: number;
  readonly maxDistance: number;
  readonly rolloff: number;
  /** Only the nearest N emitters of a kind are alive at once (bounded CPU). */
  readonly maxActive: number;
}

export const EMITTER_SPECS: Readonly<Record<EmitterKind, EmitterSpec>> = {
  crowd: { layer: 'crowd', refDistance: 4, maxDistance: 70, rolloff: 1.6, maxActive: 4 },
  fire: { layer: 'fire', refDistance: 2.5, maxDistance: 35, rolloff: 1.5, maxActive: 5 },
  bird: { layer: 'birds', refDistance: 3, maxDistance: 60, rolloff: 1.3, maxActive: 6 },
  water: { layer: 'water', refDistance: 6, maxDistance: 50, rolloff: 1.3, maxActive: 3 },
};

/** What an emitter needs from the engine. */
export interface EmitterHost {
  readonly env: AudioEnv;
  readonly listener: THREE.AudioListener;
  readonly scene: THREE.Scene;
  readonly panningModel: PanningModelType;
  /** Shared pre-rendered crackle loop for fires. */
  readonly crackle: AudioBuffer;
  layerInput(layer: LayerKey): AudioNode;
}

/**
 * A static positional sound source. The THREE.PositionalAudio and its input chain are created
 * lazily on first activation (never before start()); generators run only while the emitter is
 * among the nearest N of its kind and within range. Chain:
 * generators -> input gain (activation x distance fade) -> "air" low-pass (distance) -> panner
 * -> PositionalAudio.gain -> layer bus (time-of-day mix) -> master.
 * While inactive the object is removed from the scene so three.js does not update its panner.
 */
export abstract class PointEmitter {
  readonly kind: EmitterKind;
  readonly spec: EmitterSpec;
  readonly position: THREE.Vector3;
  readonly size: number;
  distance = Infinity;
  protected readonly rng: Rng;
  private audio: THREE.PositionalAudio | null = null;
  private input: GainNode | null = null;
  private air: BiquadFilterNode | null = null;
  private live = false;
  private releaseAt = 0;
  private lastFade = -1;
  private lastCut = -1;

  protected constructor(kind: EmitterKind, position: THREE.Vector3, size: number, rng: Rng) {
    this.kind = kind;
    this.spec = EMITTER_SPECS[kind];
    this.position = position.clone();
    this.size = size;
    this.rng = rng;
  }

  /** Generators are running (including the fade-out tail). */
  get running(): boolean {
    return this.live;
  }

  /** Wanted by the culling logic (running and not fading out). */
  get active(): boolean {
    return this.live && this.releaseAt === 0;
  }

  activate(host: EmitterHost, now: number): void {
    if (this.active) return;
    if (!this.audio || !this.input || !this.air) {
      const ctx = host.env.ctx;
      const pa = new THREE.PositionalAudio(host.listener);
      pa.panner.panningModel = host.panningModel;
      pa.setDistanceModel('inverse');
      pa.setRefDistance(this.spec.refDistance);
      pa.setRolloffFactor(this.spec.rolloff);
      pa.setMaxDistance(this.spec.maxDistance);
      // re-route from the listener input to our layer bus so the master chain applies
      pa.gain.disconnect();
      pa.gain.connect(host.layerInput(this.spec.layer));
      this.input = gainNode(ctx, 0);
      this.air = filterNode(ctx, 'lowpass', 12000, 0);
      this.input.connect(this.air);
      pa.setNodeSource(this.air);
      pa.position.copy(this.position);
      pa.name = `audio:${this.kind}`;
      this.audio = pa;
    }
    if (!this.audio.parent) host.scene.add(this.audio);
    this.audio.updateMatrixWorld(true);
    if (!this.live) {
      this.startSources(host, this.input, now);
      this.live = true;
    }
    this.releaseAt = 0;
    this.lastFade = -1;
    this.lastCut = -1;
    this.updateDistance(now);
  }

  /** Fade out; generators are stopped once the fade has finished (see tick). */
  deactivate(now: number): void {
    if (!this.live || this.releaseAt > 0) return;
    if (this.input) glide(this.input.gain, 0, now, 0.2);
    this.releaseAt = now + 1.0;
  }

  /** Per-frame: schedule events, or finish a pending fade-out. */
  tick(host: EmitterHost, now: number, horizon: number, events: boolean): void {
    if (!this.live || !this.input) return;
    if (this.releaseAt > 0) {
      if (now >= this.releaseAt) this.shutdown(now);
      return;
    }
    if (events) this.scheduleEvents(host, this.input, now, horizon, host.env.level(this.spec.layer));
  }

  /** Distance fade near maxDistance plus a darker tone with distance (air absorption, occlusion). */
  updateDistance(now: number): void {
    if (!this.input || !this.air || this.releaseAt > 0) return;
    const max = this.spec.maxDistance;
    const fade = (1 - smoothstep(max * 0.75, max, this.distance)) * this.gainScale();
    if (this.lastFade < 0 || Math.abs(fade - this.lastFade) > 0.02) {
      glide(this.input.gain, fade, now, this.lastFade < 0 ? 0.35 : 0.15);
      this.lastFade = fade;
    }
    const cut = 1200 + 14000 * Math.exp(-this.distance / 35);
    if (this.lastCut < 0 || Math.abs(cut - this.lastCut) / cut > 0.04) {
      glide(this.air.frequency, cut, now, 0.2);
      this.lastCut = cut;
    }
  }

  dispose(): void {
    if (this.live) this.shutdown(this.audio?.context.currentTime ?? 0);
    if (this.audio) {
      this.audio.disconnect();
      this.audio.panner.disconnect();
      this.audio.gain.disconnect();
      this.audio.removeFromParent();
    }
    disconnectAll([this.input, this.air]);
    this.audio = null;
    this.input = null;
    this.air = null;
  }

  protected gainScale(): number {
    return 1;
  }

  protected abstract startSources(host: EmitterHost, input: GainNode, now: number): void;
  protected abstract stopSources(when: number): void;
  protected abstract scheduleEvents(
    host: EmitterHost,
    input: GainNode,
    now: number,
    horizon: number,
    activity: number,
  ): void;

  private shutdown(now: number): void {
    this.stopSources(now);
    this.live = false;
    this.releaseAt = 0;
    this.audio?.removeFromParent();
  }
}

/** A chatting group or market cluster: 2-4 close babble voices (by size), laughter, market clatter. */
export class CrowdEmitter extends PointEmitter {
  private noise: AudioBufferSourceNode | null = null;
  private fricHp: BiquadFilterNode | null = null;
  private voices: BabbleVoice[] = [];
  private nextLaugh = 0;
  private nextExtra = 0;

  constructor(position: THREE.Vector3, size: number, rng: Rng) {
    super('crowd', position, clamp(size, 0.5, 2), rng);
  }

  protected override gainScale(): number {
    return 0.8 + 0.15 * this.size;
  }

  protected override startSources(host: EmitterHost, input: GainNode, now: number): void {
    const ctx = host.env.ctx;
    this.noise = loopNoise(ctx, host.env.noise.white, this.rng, now);
    this.fricHp = filterNode(ctx, 'highpass', 3800, 0);
    this.noise.connect(this.fricHp);
    // speakers rotate between phrases, so 2-4 synthetic voices read as a larger group
    const count = clamp(Math.round(1.2 + this.size * 1.2), 2, 4);
    this.voices = [];
    for (let i = 0; i < count; i++) {
      const opts = { noise: this.noise, fricative: this.fricHp, level: 0.9, distant: false };
      this.voices.push(new BabbleVoice(ctx, this.rng.fork(i), opts, input, now));
    }
    this.nextLaugh = now + this.rng.range(3, 15);
    this.nextExtra = now + this.rng.range(8, 30);
  }

  protected override stopSources(when: number): void {
    for (const v of this.voices) {
      v.stop(when);
      v.disconnect();
    }
    this.voices = [];
    if (this.noise) safeStop(this.noise, when);
    disconnectAll([this.noise, this.fricHp]);
    this.noise = null;
    this.fricHp = null;
  }

  protected override scheduleEvents(host: EmitterHost, input: GainNode, now: number, horizon: number, activity: number): void {
    for (const v of this.voices) v.schedule(now, horizon, activity);
    const { env } = host;
    const rng = this.rng;
    if (this.nextLaugh < horizon) {
      const t = Math.max(this.nextLaugh, now + 0.01);
      laughBurst(env, t, input, rng, rng.range(0.4, 0.65));
      this.nextLaugh = t + 3 + rng.exp(16 / (this.size * Math.max(0.2, activity)));
    }
    if (this.size >= 1 && this.nextExtra < horizon) {
      // market clusters: pottery knocked together, now and then a tethered goat
      const t = Math.max(this.nextExtra, now + 0.01);
      if (rng.chance(0.8)) {
        const n = rng.int(1, 3);
        for (let i = 0; i < n; i++) clayClink(env, t + i * rng.range(0.08, 0.3), input, rng, rng.range(0.06, 0.14));
      } else {
        bleat(env, t, input, rng, rng.range(0.2, 0.32));
      }
      this.nextExtra = t + rng.range(6, 20) / Math.max(0.3, activity);
    }
  }
}

/**
 * Torch or brazier: a low-passed brown-noise roar that "breathes" (random gain/cutoff targets,
 * livelier with wind), the shared crackle loop at a random offset/rate, and occasional resin pops.
 */
export class FireEmitter extends PointEmitter {
  private sources: AudioBufferSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private roarGain: GainNode | null = null;
  private roarLp: BiquadFilterNode | null = null;
  private nextFlicker = 0;
  private nextSnap = 0;

  constructor(position: THREE.Vector3, rng: Rng) {
    super('fire', position, 1, rng);
  }

  protected override startSources(host: EmitterHost, input: GainNode, now: number): void {
    const ctx = host.env.ctx;
    const rng = this.rng;
    const roar = loopNoise(ctx, host.env.noise.brown, rng, now, rng.range(0.9, 1.1));
    const lp = filterNode(ctx, 'lowpass', rng.range(300, 450), 0);
    const roarGain = gainNode(ctx, 0.3);
    roar.connect(lp).connect(roarGain).connect(input);

    const crackle = ctx.createBufferSource();
    crackle.buffer = host.crackle;
    crackle.loop = true;
    crackle.playbackRate.value = rng.range(0.85, 1.15);
    crackle.start(now, rng.range(0, host.crackle.duration));
    const hp = filterNode(ctx, 'highpass', 900, 0);
    const crackleGain = gainNode(ctx, rng.range(0.28, 0.4));
    crackle.connect(hp).connect(crackleGain).connect(input);

    this.sources = [roar, crackle];
    this.nodes = [lp, roarGain, hp, crackleGain];
    this.roarGain = roarGain;
    this.roarLp = lp;
    this.nextFlicker = now;
    this.nextSnap = now + rng.range(1, 4);
  }

  protected override stopSources(when: number): void {
    for (const s of this.sources) safeStop(s, when);
    disconnectAll([...this.sources, ...this.nodes]);
    this.sources = [];
    this.nodes = [];
    this.roarGain = null;
    this.roarLp = null;
  }

  protected override scheduleEvents(host: EmitterHost, input: GainNode, now: number, horizon: number): void {
    const rng = this.rng;
    if (this.nextFlicker < horizon && this.roarGain && this.roarLp) {
      const t = Math.max(this.nextFlicker, now);
      const w = host.env.wind;
      this.roarGain.gain.setTargetAtTime(rng.range(0.18, 0.42) * (1 + 0.6 * w), t, rng.range(0.08, 0.35));
      this.roarLp.frequency.setTargetAtTime(rng.range(260, 520) * (1 + 0.5 * w), t, 0.2);
      this.nextFlicker = t + rng.range(0.15, 0.7);
    }
    if (this.nextSnap < horizon) {
      const t = Math.max(this.nextSnap, now + 0.01);
      fireSnap(host.env, t, input, rng, rng.range(1, 2.5));
      this.nextSnap = t + 0.2 + rng.exp(2.5);
    }
  }
}

type BirdSpecies = 'swift' | 'dove' | 'sparrow';

/** A palm crown or wall-top perch with its own mix of sparrows, swifts/swallows and doves. */
export class BirdEmitter extends PointEmitter {
  private readonly weights: readonly (readonly [BirdSpecies, number])[];
  private next = 0;

  constructor(position: THREE.Vector3, rng: Rng) {
    super('bird', position, 1, rng);
    this.weights = [
      ['sparrow', rng.range(0.5, 2)],
      ['swift', rng.range(0.2, 1.2)],
      ['dove', rng.range(0.3, 1.2)],
    ];
  }

  protected override startSources(_host: EmitterHost, _input: GainNode, now: number): void {
    this.next = now + this.rng.range(0.2, 3);
  }

  protected override stopSources(): void {
    /* one-shots only */
  }

  protected override scheduleEvents(host: EmitterHost, input: GainNode, now: number, horizon: number, activity: number): void {
    const rng = this.rng;
    if (this.next < now - 1) this.next = now + rng.range(0, 2);
    while (this.next < horizon) {
      const t = Math.max(this.next, now + 0.01);
      const species = rng.weighted(this.weights);
      if (species === 'swift') swiftTrill(host.env, t, input, rng, rng.range(0.2, 0.4));
      else if (species === 'dove') doveCoo(host.env, t, input, rng, rng.range(0.3, 0.5));
      else sparrowChatter(host.env, t, input, rng, rng.range(0.2, 0.4));
      // birds answer each other in bursts, then fall quiet for a while
      const mean = (species === 'dove' ? 7 : 3) / Math.max(0.08, activity);
      this.next = t + (rng.chance(0.3) ? rng.range(0.4, 1.5) : 0.8 + rng.exp(mean));
    }
  }
}

/**
 * Canal water: pink noise through a low-pass whose gain and cutoff swell with each wavelet against
 * the bank (scheduled "laps"), a short bright splash at each crest, and sparse bubble plips.
 */
export class WaterEmitter extends PointEmitter {
  private source: AudioBufferSourceNode | null = null;
  private nodes: AudioNode[] = [];
  private lap: GainNode | null = null;
  private lapLp: BiquadFilterNode | null = null;
  private shimmer: GainNode | null = null;
  private nextLap = 0;
  private nextBubble = 0;

  constructor(position: THREE.Vector3, rng: Rng) {
    super('water', position, 1, rng);
  }

  protected override startSources(host: EmitterHost, input: GainNode, now: number): void {
    const ctx = host.env.ctx;
    const rng = this.rng;
    const src = loopNoise(ctx, host.env.noise.pink, rng, now);
    const lp = filterNode(ctx, 'lowpass', 450, 0);
    const lap = gainNode(ctx, 0.22);
    const bp = filterNode(ctx, 'bandpass', rng.range(1500, 2200), 1.2);
    const shimmer = gainNode(ctx, 0);
    src.connect(lp).connect(lap).connect(input);
    src.connect(bp).connect(shimmer).connect(input);
    this.source = src;
    this.nodes = [lp, lap, bp, shimmer];
    this.lap = lap;
    this.lapLp = lp;
    this.shimmer = shimmer;
    this.nextLap = now + rng.range(0, 1);
    this.nextBubble = now + rng.range(0.5, 2);
  }

  protected override stopSources(when: number): void {
    if (this.source) safeStop(this.source, when);
    disconnectAll([this.source, ...this.nodes]);
    this.source = null;
    this.nodes = [];
    this.lap = null;
    this.lapLp = null;
    this.shimmer = null;
  }

  protected override scheduleEvents(host: EmitterHost, input: GainNode, now: number, horizon: number): void {
    const rng = this.rng;
    if (this.nextLap < horizon && this.lap && this.lapLp && this.shimmer) {
      const t = Math.max(this.nextLap, now + 0.01);
      const rise = rng.range(0.25, 0.6);
      const fall = rng.range(0.4, 1.0);
      const a = rng.range(0.5, 1) * (0.8 + 0.4 * host.env.wind);
      this.lap.gain.setTargetAtTime(0.6 * a, t, rise / 3);
      this.lap.gain.setTargetAtTime(0.18, t + rise, fall / 3);
      this.lapLp.frequency.setTargetAtTime(500 + 500 * a, t, rise / 3);
      this.lapLp.frequency.setTargetAtTime(380, t + rise, fall / 3);
      this.shimmer.gain.setTargetAtTime(0.4 * a, t + rise * 0.8, 0.03);
      this.shimmer.gain.setTargetAtTime(0, t + rise * 0.8 + 0.08, 0.08);
      this.nextLap = t + rise + fall * rng.range(0.6, 1.3);
    }
    if (this.nextBubble < horizon) {
      const t = Math.max(this.nextBubble, now + 0.01);
      bubble(host.env, t, input, rng, rng.range(0.03, 0.07));
      this.nextBubble = t + 0.1 + rng.exp(1.6);
    }
  }
}
