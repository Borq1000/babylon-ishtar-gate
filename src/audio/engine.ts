import * as THREE from 'three';
import {
  type AudioEnv,
  LAYER_KEYS,
  type LayerKey,
  LOOKAHEAD,
  type TimeOfDayKey,
  VoiceBudget,
  clamp,
  disconnectAll,
  fadeTo,
  filterNode,
  gainNode,
  glide,
  panNode,
} from './core';
import { EMITTER_KINDS, EMITTER_SPECS, type EmitterHost, type PointEmitter } from './emitters';
import { FootstepBank, LyreBank } from './instruments';
import { CricketChorus, WindBed, doveCoo, owlHoot, renderCrackle, sparrowChatter, swiftTrill } from './nature';
import { type NoiseBank, createNoiseBank } from './noise';
import { ProcessionEngine } from './procession';
import { Rng } from './rng';
import { MurmurBed } from './voices';

/** Layer mix per time of day (0..1, before trims). Crossfaded over ~3 s. */
export const TIME_OF_DAY_MIX: Readonly<Record<TimeOfDayKey, Readonly<Record<LayerKey, number>>>> = {
  morning: { wind: 0.8, murmur: 0.5, crowd: 0.6, procession: 0.2, birds: 1, owl: 0, crickets: 0, fire: 0, water: 1 },
  midday: { wind: 1, murmur: 1, crowd: 1, procession: 0.5, birds: 0.35, owl: 0, crickets: 0, fire: 0, water: 0.9 },
  golden: { wind: 0.8, murmur: 0.65, crowd: 0.85, procession: 1, birds: 0.6, owl: 0, crickets: 0.15, fire: 0.08, water: 1 },
  night: { wind: 0.6, murmur: 0.12, crowd: 0.3, procession: 0, birds: 0, owl: 1, crickets: 1, fire: 1, water: 1 },
};

/** Static per-layer balance applied on top of the time-of-day mix. */
export const LAYER_TRIM: Readonly<Record<LayerKey, number>> = {
  wind: 0.6,
  murmur: 0.45,
  crowd: 1.2,
  procession: 1.1,
  birds: 0.8,
  owl: 0.6,
  crickets: 0.9,
  fire: 1.1,
  water: 1.05,
};

/** Shared reverb sends (a walled street of glazed brick): mostly for music and voices. */
const REVERB_SEND: Partial<Record<LayerKey, number>> = {
  procession: 0.3,
  crowd: 0.12,
  murmur: 0.15,
  birds: 0.08,
  owl: 0.45,
};

const PROCESSION_MAX_DISTANCE = 170;
const MASTER_HEADROOM = 1.0;

/**
 * Soft limiter. The Web Audio compressor always adds an automatic makeup gain derived from its
 * curve (+4.06 dB for these settings, measured in Chromium; Firefox/Safari share the WebKit-derived
 * algorithm). We cancel it, so the chain is unity below about -14 dBFS and only tames peaks
 * (sustained ceiling about -6 dBFS).
 */
const LIMITER = { threshold: -10, knee: 6, ratio: 8, attack: 0.005, release: 0.25, makeupDb: 4.06 } as const;

export interface EngineOptions {
  readonly seed: number;
  readonly maxEventNodes: number;
  readonly reverb: boolean;
  /** HRTF panning for the (single) procession emitter. */
  readonly hrtf: boolean;
  /** HRTF panning for point emitters too (costlier; default equal-power). */
  readonly hrtfEmitters: boolean;
}

export interface EngineState {
  readonly timeOfDay: TimeOfDayKey;
  readonly wind: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly trims: Partial<Record<LayerKey, number>>;
}

/** Perceptual taper for the 0..1 master volume. */
function volumeGain(v: number): number {
  return Math.pow(clamp(v, 0, 1), 1.7) * MASTER_HEADROOM;
}

/**
 * Short, dark stereo impulse response: sparse early reflections off brick facades plus a diffuse
 * tail (RT60 ~1.3 s) whose highs die faster (a one-pole low-pass that closes over time).
 */
function renderImpulse(ctx: BaseAudioContext, rng: Rng, seconds = 1.4): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const ir = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp += (0.08 + 0.6 * Math.exp(-t * 4)) * (rng.next() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 5.2) * (t < 0.015 ? t / 0.015 : 1);
    }
    for (let r = 0; r < 7; r++) {
      const k = Math.floor(rng.range(0.011, 0.09) * sr);
      d[k] = d[k]! + rng.range(-0.6, 0.6);
    }
  }
  return ir;
}

/**
 * The built audio graph and its scheduler. Created by Soundscape.start(); everything here
 * assumes a live AudioContext. Master chain: layer buses -> bus (volume) -> soft-knee compressor
 * -> mute/fade gain -> listener input. Positional sources are re-routed from the listener input
 * to their layer bus so the time-of-day mix and the master chain apply to them too.
 */
export class SoundEngine implements AudioEnv, EmitterHost {
  readonly ctx: AudioContext;
  readonly noise: NoiseBank;
  readonly budget: VoiceBudget;
  readonly listener: THREE.AudioListener;
  readonly scene: THREE.Scene;
  readonly panningModel: PanningModelType;
  readonly crackle: AudioBuffer;
  wind: number;

  private readonly rng: Rng;
  private readonly bus: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly out: GainNode;
  private readonly layers: Record<LayerKey, GainNode>;
  private readonly mixCur: Record<LayerKey, number>;
  private readonly mixTgt: Record<LayerKey, number>;
  private readonly trims: Record<LayerKey, number>;
  private readonly extraNodes: AudioNode[] = [];
  private readonly windBed: WindBed;
  private readonly murmur: MurmurBed;
  private crickets: CricketChorus | null = null;
  private readonly procession: ProcessionEngine;
  private readonly procAudio: THREE.PositionalAudio;
  private readonly procFade: GainNode;
  private readonly procAir: BiquadFilterNode;
  private readonly procPos = new THREE.Vector3();
  private readonly procSample = new THREE.Vector3();
  private procSampleTime = 0;
  private procKnown = false;
  private procActive = false;
  private procLevel = 0;
  private procSpeed = 0;
  private readonly cam = new THREE.Vector3();
  private readonly scratch: PointEmitter[] = [];
  private manageTimer = 0;
  private owlNext: number;
  private readonly farBirdPans: StereoPannerNode[] = [];
  private farBirdNext: number;
  private muted: boolean;
  private muteFadeEnd = 0;
  private lastResumeAttempt = 0;
  private disposed = false;

  constructor(listener: THREE.AudioListener, scene: THREE.Scene, opts: EngineOptions, state: EngineState) {
    this.listener = listener;
    this.scene = scene;
    this.ctx = listener.context;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.rng = new Rng(opts.seed);
    this.noise = createNoiseBank(ctx, this.rng.fork(1));
    this.budget = new VoiceBudget(ctx, opts.maxEventNodes);
    this.crackle = renderCrackle(ctx, this.rng.fork(2));
    this.panningModel = opts.hrtfEmitters ? 'HRTF' : 'equalpower';
    this.wind = clamp(state.wind, 0, 1);
    this.muted = state.muted;

    // Master: volume -> soft limiter (makeup cancelled) -> mute/fade -> listener input.
    this.bus = gainNode(ctx, volumeGain(state.volume));
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = LIMITER.threshold;
    this.comp.knee.value = LIMITER.knee;
    this.comp.ratio.value = LIMITER.ratio;
    this.comp.attack.value = LIMITER.attack;
    this.comp.release.value = LIMITER.release;
    const makeup = gainNode(ctx, Math.pow(10, -LIMITER.makeupDb / 20));
    const subsonic = filterNode(ctx, 'highpass', 25, 0); // drift of brown-noise loops, speaker safety
    this.out = gainNode(ctx, 0);
    this.bus.connect(subsonic).connect(this.comp).connect(makeup).connect(this.out).connect(listener.getInput());
    this.extraNodes.push(subsonic, makeup);
    fadeTo(this.out.gain, this.muted ? 0 : 1, now, 2.0); // fade in on start

    const mix = TIME_OF_DAY_MIX[state.timeOfDay];
    const layers = {} as Record<LayerKey, GainNode>;
    this.mixCur = {} as Record<LayerKey, number>;
    this.mixTgt = {} as Record<LayerKey, number>;
    this.trims = {} as Record<LayerKey, number>;
    for (const k of LAYER_KEYS) {
      this.trims[k] = LAYER_TRIM[k] * (state.trims[k] ?? 1);
      this.mixCur[k] = mix[k];
      this.mixTgt[k] = mix[k];
      const g = gainNode(ctx, mix[k] * this.trims[k]);
      g.connect(this.bus);
      layers[k] = g;
    }
    this.layers = layers;

    if (opts.reverb) {
      const send = gainNode(ctx, 1);
      const conv = ctx.createConvolver();
      conv.buffer = renderImpulse(ctx, this.rng.fork(3));
      const ret = gainNode(ctx, 0.35);
      send.connect(conv).connect(ret).connect(this.bus);
      this.extraNodes.push(send, conv, ret);
      for (const k of LAYER_KEYS) {
        const amount = REVERB_SEND[k];
        if (!amount) continue;
        const s = gainNode(ctx, amount);
        layers[k].connect(s).connect(send);
        this.extraNodes.push(s);
      }
    }

    this.windBed = new WindBed(this, this.rng.fork(4), layers.wind, this.wind);
    this.murmur = new MurmurBed(this, this.rng.fork(5), layers.murmur, 5);

    // Birds elsewhere over the rooftops: one-shots through a few fixed stereo positions + darkening.
    const farBirds = filterNode(ctx, 'lowpass', 5500, 0);
    farBirds.connect(layers.birds);
    for (const p of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const pan = panNode(ctx, p);
      pan.connect(farBirds);
      this.farBirdPans.push(pan);
    }
    this.extraNodes.push(farBirds, ...this.farBirdPans);
    this.farBirdNext = now + this.rng.range(1, 4);

    // Procession: one moving positional emitter (HRTF by default: it is the musical focus).
    const lyre = new LyreBank(ctx, this.rng.fork(6));
    const steps = new FootstepBank(ctx, this.rng.fork(7));
    this.procession = new ProcessionEngine(this, this.rng.fork(8), lyre, steps);
    this.procFade = gainNode(ctx, 0);
    this.procAir = filterNode(ctx, 'lowpass', 12000, 0);
    this.procession.input.connect(this.procFade).connect(this.procAir);
    const pa = new THREE.PositionalAudio(listener);
    pa.panner.panningModel = opts.hrtf ? 'HRTF' : 'equalpower';
    pa.setDistanceModel('inverse');
    pa.setRefDistance(7);
    pa.setRolloffFactor(1.1);
    pa.setMaxDistance(PROCESSION_MAX_DISTANCE);
    pa.gain.disconnect();
    pa.gain.connect(layers.procession);
    pa.setNodeSource(this.procAir);
    pa.name = 'audio:procession';
    this.procAudio = pa;

    this.owlNext = now + this.rng.range(15, 45);
    this.manageBeds();
  }

  level(layer: LayerKey): number {
    return this.mixCur[layer];
  }

  layerInput(layer: LayerKey): AudioNode {
    return this.layers[layer];
  }

  get env(): AudioEnv {
    return this;
  }

  get activeEventNodes(): number {
    return this.budget.active;
  }

  get droppedEvents(): number {
    const d = this.budget.dropped;
    return d[0] + d[1] + d[2];
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    const now = this.ctx.currentTime;
    this.muted = muted;
    this.muteFadeEnd = now + 0.6;
    fadeTo(this.out.gain, muted ? 0 : 1, now, 0.6);
  }

  setVolume(v: number): void {
    glide(this.bus.gain, volumeGain(v), this.ctx.currentTime, 0.08);
  }

  setTimeOfDay(key: TimeOfDayKey): void {
    const now = this.ctx.currentTime;
    const mix = TIME_OF_DAY_MIX[key];
    for (const k of LAYER_KEYS) {
      this.mixTgt[k] = mix[k];
      glide(this.layers[k].gain, mix[k] * this.trims[k], now, 1.0); // ~95% after 3 s
    }
    this.manageTimer = 0;
    this.manageBeds();
  }

  setLayerTrim(layer: LayerKey, trim: number): void {
    this.trims[layer] = LAYER_TRIM[layer] * Math.max(0, trim);
    glide(this.layers[layer].gain, this.mixTgt[layer] * this.trims[layer], this.ctx.currentTime, 0.3);
  }

  setWind(strength: number): void {
    this.wind = clamp(strength, 0, 1);
    this.windBed.setStrength(this.wind, this.ctx.currentTime);
  }

  setProcession(position: THREE.Vector3, active: boolean): void {
    const now = this.ctx.currentTime;
    if (!this.procKnown || now - this.procSampleTime > 2) {
      this.procSample.copy(position);
      this.procSampleTime = now;
    } else if (now - this.procSampleTime >= 0.25) {
      // walking speed estimate: a standing column only shuffles its feet
      const v = this.procSample.distanceTo(position) / (now - this.procSampleTime);
      this.procSpeed += (Math.min(v, 5) - this.procSpeed) * 0.5;
      this.procSample.copy(position);
      this.procSampleTime = now;
    }
    this.procPos.copy(position);
    this.procAudio.position.copy(position);
    if (!this.procKnown) {
      this.procKnown = true;
      this.scene.add(this.procAudio);
      this.procAudio.updateMatrixWorld(true);
    }
    if (active !== this.procActive) {
      this.procActive = active;
      glide(this.procFade.gain, active ? 1 : 0, now, active ? 1.2 : 1.5);
    }
  }

  update(dt: number, cameraPosition: THREE.Vector3, emitters: readonly PointEmitter[]): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      const t = performance.now();
      if (t - this.lastResumeAttempt > 1500) {
        this.lastResumeAttempt = t;
        ctx.resume().catch(() => undefined);
      }
    }
    const now = ctx.currentTime;
    const step = clamp(dt, 0, 0.25);
    // JS mirrors of the audio-rate crossfades (used to thin out event density)
    const k = 1 - Math.exp(-step / 1.0);
    for (const key of LAYER_KEYS) this.mixCur[key] += (this.mixTgt[key] - this.mixCur[key]) * k;
    this.procLevel += ((this.procActive ? 1 : 0) - this.procLevel) * (1 - Math.exp(-step / 1.3));
    this.cam.copy(cameraPosition);

    const events = !this.muted || now < this.muteFadeEnd;
    const horizon = now + LOOKAHEAD;

    this.manageTimer -= step;
    if (this.manageTimer <= 0) {
      this.manageTimer = 0.25;
      this.manageEmitters(now, emitters);
      this.manageBeds();
      this.updateProcessionTone(now);
    }

    this.windBed.schedule(now, horizon);
    if (events) {
      this.murmur.schedule(now, horizon, this.mixCur.murmur);
      this.crickets?.schedule(now, horizon, this.mixCur.crickets);
      this.scheduleOwl(now, horizon);
      this.scheduleFarBirds(now, horizon);
    }
    const procDistance = this.procKnown ? this.procPos.distanceTo(this.cam) : Infinity;
    const intensity = this.mixCur.procession * this.procLevel;
    const audible = events && procDistance < PROCESSION_MAX_DISTANCE;
    this.procession.schedule(now, horizon, intensity, clamp(this.procSpeed, 0, 1), audible);

    for (const e of emitters) if (e.running) e.tick(this, now, horizon, events);
  }

  dispose(emitters: readonly PointEmitter[]): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of emitters) e.dispose();
    this.windBed.dispose();
    this.murmur.dispose();
    this.crickets?.dispose();
    this.crickets = null;
    this.procession.dispose();
    this.procAudio.disconnect();
    this.procAudio.panner.disconnect();
    this.procAudio.gain.disconnect();
    this.procAudio.removeFromParent();
    const nodes: AudioNode[] = [this.procFade, this.procAir, ...this.extraNodes, this.bus, this.comp];
    for (const k of LAYER_KEYS) nodes.push(this.layers[k]);
    disconnectAll(nodes);
    // quick fade before detaching from the listener to avoid a click
    const out = this.out;
    fadeTo(out.gain, 0, this.ctx.currentTime, 0.05);
    setTimeout(() => out.disconnect(), 120);
  }

  /** Nearest-N activation per kind, with hysteresis; kinds whose layer is silent are fully parked. */
  private manageEmitters(now: number, emitters: readonly PointEmitter[]): void {
    const list = this.scratch;
    for (const kind of EMITTER_KINDS) {
      const spec = EMITTER_SPECS[kind];
      const enabled = this.mixTgt[spec.layer] > 0.001 || this.mixCur[spec.layer] > 0.01;
      list.length = 0;
      for (const e of emitters) {
        if (e.kind !== kind) continue;
        e.distance = e.position.distanceTo(this.cam);
        list.push(e);
      }
      if (list.length === 0) continue;
      list.sort((a, b) => a.distance * (a.active ? 0.85 : 1) - b.distance * (b.active ? 0.85 : 1));
      let slots = enabled ? spec.maxActive : 0;
      for (const e of list) {
        const inRange = e.distance < spec.maxDistance * (e.active ? 1 : 0.95);
        if (slots > 0 && inRange) {
          slots--;
          if (e.active) e.updateDistance(now);
          else e.activate(this, now);
        } else if (e.active) {
          e.deactivate(now);
        }
      }
    }
    list.length = 0;
  }

  /** Crickets exist only while their layer is (or is becoming) audible. */
  private manageBeds(): void {
    const want = this.mixTgt.crickets > 0.001 || this.mixCur.crickets > 0.005;
    if (want && !this.crickets) {
      this.crickets = new CricketChorus(this, this.rng.fork(9), this.layers.crickets, 4);
    } else if (!want && this.crickets) {
      this.crickets.dispose();
      this.crickets = null;
    }
  }

  private updateProcessionTone(now: number): void {
    if (!this.procKnown) return;
    const d = this.procPos.distanceTo(this.cam);
    glide(this.procAir.frequency, 1500 + 14000 * Math.exp(-d / 45), now, 0.25);
  }

  /** Sparse, quieter, darker calls from elsewhere in the city; density follows the birds layer. */
  private scheduleFarBirds(now: number, horizon: number): void {
    const rng = this.rng;
    const level = this.mixCur.birds;
    if (this.farBirdNext < now - 1) this.farBirdNext = now + rng.range(0.2, 2);
    if (this.farBirdNext >= horizon) return;
    const t = Math.max(this.farBirdNext, now + 0.02);
    if (level > 0.1) {
      const dest = rng.pick(this.farBirdPans);
      const species = rng.weighted([
        ['sparrow', 5],
        ['swift', 3.5],
        ['dove', 1.5],
      ] as const);
      const a = rng.range(0.03, 0.07);
      if (species === 'swift') swiftTrill(this, t, dest, rng, a);
      else if (species === 'dove') doveCoo(this, t, dest, rng, a * 1.3);
      else sparrowChatter(this, t, dest, rng, a);
    }
    this.farBirdNext = t + 0.5 + rng.exp(2.2 / Math.max(0.1, level));
  }

  private scheduleOwl(now: number, horizon: number): void {
    if (this.owlNext < now - 1) this.owlNext = now + this.rng.range(5, 20);
    if (this.owlNext >= horizon) return;
    const t = Math.max(this.owlNext, now + 0.02);
    if (this.mixCur.owl > 0.3) owlHoot(this, t, this.layers.owl, this.rng, 0.09);
    this.owlNext = t + this.rng.range(25, 80);
  }
}
