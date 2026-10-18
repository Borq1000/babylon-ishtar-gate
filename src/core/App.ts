// Application root: renderer, scene, lighting, atmosphere, post-processing,
// world, camera modes, audio and UI wiring, plus the frame loop.

import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { createRenderer } from './Renderer';
import { QUALITY_PRESETS, type QualityLevel, type QualitySettings } from './Quality';
import { DynamicResolution, FrameStats } from './Loop';
import { Atmosphere } from '../environment/Atmosphere';
import { TimeOfDay, type TimeKey } from '../environment/TimeOfDay';
import { SkySystem } from '../environment/Sky';
import { PostFX } from '../rendering/PostFX';
import { VolumeShadow } from '../rendering/VolumeShadow';
import { sharedUniforms } from '../materials/MaterialPatches';

export interface Updatable {
  update(dt: number, time: number): void;
}

export type ProgressFn = (fraction: number, label: string) => void;

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly atmosphere = new Atmosphere();
  readonly timeOfDay: TimeOfDay;
  readonly sky: SkySystem;
  readonly sun: SunLight;
  readonly volume: VolumeShadow;
  post!: PostFX;
  quality: QualitySettings;
  readonly stats = new FrameStats();
  readonly dynRes: DynamicResolution;
  readonly updatables: Updatable[] = [];
  /** Called every frame before rendering (camera controllers etc.). */
  readonly preUpdate: ((dt: number, time: number) => void)[] = [];
  readonly onQualityChange: ((q: QualitySettings) => void)[] = [];
  readonly onTimeChange: ((k: TimeKey) => void)[] = [];
  time = 0;
  private lastFrame = performance.now();
  private envTimer = 0;
  private envDirty = true;
  private running = false;
  private basePixelRatio = 1;
  paused = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    qualityLevel: QualityLevel,
  ) {
    this.quality = { ...QUALITY_PRESETS[qualityLevel] };
    this.renderer = createRenderer(canvas);
    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.25, 6500);
    this.camera.position.set(-1.5, 1.7, 95);
    this.camera.lookAt(0, 8, 0);
    this.scene.add(this.camera);

    this.timeOfDay = new TimeOfDay('golden');
    this.timeOfDay.onChange = (k) => this.onTimeChange.forEach((f) => f(k));
    this.atmosphere.apply(this.timeOfDay.state);

    this.sky = new SkySystem(this.renderer, this.atmosphere);
    this.scene.add(this.sky.dome);

    this.sun = new SunLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.applyShadowQuality();
    this.scene.add(this.sun);

    this.volume = new VolumeShadow(this.renderer, this.quality.level === 'ultra' ? 2048 : 1024, 240);
    this.dynRes = new DynamicResolution(this.quality.renderScaleMin, this.quality.renderScaleMax);

    this.post = new PostFX(this.renderer, this.scene, this.camera, this.atmosphere, this.volume, this.quality);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private applyShadowQuality(): void {
    const q = this.quality;
    const s = this.sun.shadow;
    if (s.mapSize.x !== q.shadowMapSize) {
      s.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      s.map?.dispose();
      s.map = null;
    }
    s.camera.far = q.shadowDistance;
    s.camera.near = 1;
    s.bias = -0.00025;
    s.normalBias = 0.035;
    s.radius = q.shadowRadius;
  }

  setQuality(level: QualityLevel): void {
    this.quality = { ...QUALITY_PRESETS[level] };
    this.applyShadowQuality();
    this.dynRes.setBounds(this.quality.renderScaleMin, this.quality.renderScaleMax);
    this.dynRes.scale = this.quality.renderScaleMax;
    this.post.setQuality(this.quality);
    this.resize();
    this.onQualityChange.forEach((f) => f(this.quality));
  }

  setTime(key: TimeKey, instant = false): void {
    this.timeOfDay.set(key, instant);
    this.envDirty = true;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioMax);
    const pr = this.basePixelRatio * this.dynRes.scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
  }

  /** Pre-compiles all materials so the first frames do not hitch. */
  async precompile(): Promise<void> {
    this.scene.updateMatrixWorld(true);
    this.sky.captureEnvironment();
    this.scene.environment = this.sky.captureEnvironment();
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      this.renderer.compile(this.scene, this.camera);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    let dtMs = now - this.lastFrame;
    this.lastFrame = now;
    if (dtMs > 250) dtMs = 250;
    this.stats.push(dtMs);
    // dynamic resolution
    if (this.dynRes.update(dtMs / 1000, this.stats)) this.resize();
    this.step(this.paused ? 0 : dtMs / 1000);
  }

  /** Runs one full simulation + render step (also used for deterministic captures). */
  step(dt: number): void {
    this.time += dt;

    for (const f of this.preUpdate) f(dt, this.time);

    // atmosphere / time of day
    const changed = this.timeOfDay.update(dt);
    if (changed) this.envDirty = true;
    const p = this.timeOfDay.state;
    this.atmosphere.apply(p);
    this.sun.position.copy(this.atmosphere.keyLightDir).multiplyScalar(100);
    this.sun.color.copy(this.atmosphere.keyLightColor);
    this.sun.intensity = this.atmosphere.keyLightIntensity;
    this.sun.updateMatrixWorld();
    this.scene.environmentIntensity = p.envIntensity;
    this.sky.update(this.time, this.camera.position);

    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this.scene.environment = this.sky.captureEnvironment();
      this.envTimer = this.timeOfDay.transitioning ? 0.12 : 0;
      this.envDirty = this.timeOfDay.transitioning;
    }

    // post uniforms driven by the atmosphere
    const fx = this.post.atmosphereEffect;
    fx.u('uFogDensity').value = p.fogDensity;
    fx.u('uFogHeight').value = p.fogHeight;
    fx.u('uSunLobe').value = 0.55 * p.fogSunScatter;
    fx.u('uSunShare').value = 0.62 * (1 - p.night) + 0.35 * p.night;
    fx.u('uAmbientScatter').value = p.fogAmbient;
    fx.u('uGroundHaze').value = 0.0009 * p.dust * (1 - 0.6 * p.night);
    (fx.u('uKeyColor').value as THREE.Color).copy(this.atmosphere.keyLightColor).multiplyScalar(this.atmosphere.keyLightIntensity * 0.12);
    (fx.u('uKeyDir').value as THREE.Vector3).copy(this.atmosphere.keyLightDir);
    fx.u('uMarchDist').value = this.quality.shadowDistance;
    this.post.setExposure(p.exposure);
    this.post.grading.set('uNight', p.night);

    // shared material uniforms
    this.camera.updateMatrixWorld();
    sharedUniforms.uTime.value = this.time;
    sharedUniforms.uKeyDirView.value.copy(this.atmosphere.keyLightDir).transformDirection(this.camera.matrixWorldInverse);
    sharedUniforms.uBounceE.value.copy(this.atmosphere.keyLightColor).multiplyScalar(this.atmosphere.keyLightIntensity);
    sharedUniforms.uBounceL.value.copy(this.atmosphere.keyLightDir);

    for (const u of this.updatables) u.update(dt, this.time);

    if (this.quality.volumetricSteps > 0) this.volume.update(this.scene, this.camera.position, this.atmosphere.keyLightDir);

    this.renderer.info.reset();
    this.post.render(dt);
  }
}
