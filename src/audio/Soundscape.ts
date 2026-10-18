import * as THREE from 'three';
import { type LayerKey, type TimeOfDayKey, clamp } from './core';
import { BirdEmitter, CrowdEmitter, FireEmitter, type PointEmitter, WaterEmitter } from './emitters';
import { SoundEngine } from './engine';
import { Rng } from './rng';

export type { LayerKey, TimeOfDayKey } from './core';
export { LAYER_TRIM, TIME_OF_DAY_MIX } from './engine';

export interface SoundscapeOptions {
  /** RNG seed: same seed, same "performance" (default 0xBAB575). */
  seed?: number;
  /** Upper bound on simultaneously alive one-shot event nodes (default 60). */
  maxEventNodes?: number;
  /** Shared short convolution reverb for the walled street (default true). */
  reverb?: boolean;
  /** HRTF panning for the procession emitter (default true). */
  hrtf?: boolean;
  /** HRTF panning for crowd/bird/fire/water emitters too (default false: equal-power is cheaper). */
  hrtfEmitters?: boolean;
}

export interface SoundscapeStats {
  started: boolean;
  contextState: AudioContextState | 'none';
  activeEventNodes: number;
  /** One-shot events refused by the voice budget since start (rising fast = budget too small). */
  droppedEvents: number;
  emitters: number;
  activeEmitters: number;
}

/**
 * Procedural ambience for the Processional Way, Babylon 575 BCE. Everything is synthesised with
 * the Web Audio API; no samples. Usage:
 *
 *   const soundscape = new Soundscape(listener, scene);
 *   soundscape.addCrowdEmitter(pos, 1.2); ...           // any time, also before start()
 *   button.onclick = () => soundscape.start();          // must be a user gesture
 *   // every frame:
 *   soundscape.setProcession(processionPos, isActive);
 *   soundscape.update(dt, camera.position);
 *
 * Nothing touches the AudioContext before start(); setters and add* calls made earlier are
 * remembered and applied when the graph is built.
 */
export class Soundscape {
  private readonly listener: THREE.AudioListener;
  private readonly scene: THREE.Scene;
  private readonly options: Required<SoundscapeOptions>;
  private readonly rng: Rng;
  private readonly emitters: PointEmitter[] = [];
  private engine: SoundEngine | null = null;
  private disposed = false;

  private muted = false;
  private volume = 0.8;
  private timeOfDay: TimeOfDayKey = 'midday';
  private wind = 0.35;
  private readonly trims: Partial<Record<LayerKey, number>> = {};
  private readonly procPos = new THREE.Vector3();
  private procActive = false;
  private procKnown = false;

  constructor(listener: THREE.AudioListener, scene: THREE.Scene, options: SoundscapeOptions = {}) {
    this.listener = listener;
    this.scene = scene;
    this.options = {
      seed: options.seed ?? 0xbab575,
      maxEventNodes: options.maxEventNodes ?? 60,
      reverb: options.reverb ?? true,
      hrtf: options.hrtf ?? true,
      hrtfEmitters: options.hrtfEmitters ?? false,
    };
    this.rng = new Rng(this.options.seed ^ 0x5a5a);
  }

  get started(): boolean {
    return this.engine !== null;
  }

  /**
   * Builds the graph and resumes the context. Call from a user gesture (click/key); the resume()
   * request is issued synchronously, before any await. Safe to call more than once.
   */
  async start(): Promise<void> {
    if (this.disposed) return;
    const ctx = this.listener.context;
    const resuming = ctx.state === 'running' ? null : ctx.resume();
    if (!this.engine) {
      this.engine = new SoundEngine(this.listener, this.scene, this.options, {
        timeOfDay: this.timeOfDay,
        wind: this.wind,
        volume: this.volume,
        muted: this.muted,
        trims: this.trims,
      });
      if (this.procKnown) this.engine.setProcession(this.procPos, this.procActive);
    }
    if (resuming) {
      try {
        await resuming;
      } catch {
        /* retried from update() */
      }
    }
  }

  /** Smooth 0.6 s fade. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
  }

  /** 0..1 (perceptual taper applied internally). */
  setMasterVolume(v: number): void {
    this.volume = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this.engine?.setVolume(this.volume);
  }

  /** Crossfades the layer mix over ~3 s. */
  setTimeOfDay(key: TimeOfDayKey): void {
    this.timeOfDay = key;
    this.engine?.setTimeOfDay(key);
  }

  /** 0..1: drives the wind bed, gust size/rate, fire flicker and water chop. */
  setWind(strength: number): void {
    this.wind = clamp(Number.isFinite(strength) ? strength : 0, 0, 1);
    this.engine?.setWind(this.wind);
  }

  /** Moving emitter for drums, lyre, chant and footsteps. Call every frame; inactive = fade out. */
  setProcession(position: THREE.Vector3, active: boolean): void {
    this.procPos.copy(position);
    this.procActive = active;
    this.procKnown = true;
    this.engine?.setProcession(position, active);
  }

  /** A chatting group / market cluster; size 0.5..2 (voices, level, market clatter at >= 1). */
  addCrowdEmitter(position: THREE.Vector3, size = 1): void {
    if (this.disposed) return;
    this.emitters.push(new CrowdEmitter(position, size, this.forkRng()));
  }

  /** Torch/brazier: only audible when the fire layer is up (night, faintly at dusk). */
  addFireEmitter(position: THREE.Vector3): void {
    if (this.disposed) return;
    this.emitters.push(new FireEmitter(position, this.forkRng()));
  }

  /** Palm crown / wall-top bird spot. */
  addBirdEmitter(position: THREE.Vector3): void {
    if (this.disposed) return;
    this.emitters.push(new BirdEmitter(position, this.forkRng()));
  }

  /** Canal / moat water. */
  addWaterEmitter(position: THREE.Vector3): void {
    if (this.disposed) return;
    this.emitters.push(new WaterEmitter(position, this.forkRng()));
  }

  /** Scheduler tick + distance culling. Call every frame with the camera (listener) position. */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    this.engine?.update(Number.isFinite(dt) ? dt : 0, cameraPosition, this.emitters);
  }

  /** Optional: rebalance a layer (multiplier on the built-in trim, default 1). */
  setLayerTrim(layer: LayerKey, trim: number): void {
    this.trims[layer] = Math.max(0, trim);
    this.engine?.setLayerTrim(layer, this.trims[layer] ?? 1);
  }

  /** Optional: debugging info for an overlay. */
  getStats(): SoundscapeStats {
    let active = 0;
    for (const e of this.emitters) if (e.active) active++;
    return {
      started: this.started,
      contextState: this.engine ? this.listener.context.state : 'none',
      activeEventNodes: this.engine?.activeEventNodes ?? 0,
      droppedEvents: this.engine?.droppedEvents ?? 0,
      emitters: this.emitters.length,
      activeEmitters: active,
    };
  }

  /** Stops and disconnects everything this module created (the AudioContext is left alone). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.engine) this.engine.dispose(this.emitters);
    else for (const e of this.emitters) e.dispose();
    this.emitters.length = 0;
    this.engine = null;
  }

  private forkRng(): Rng {
    return this.rng.fork(this.emitters.length);
  }
}
