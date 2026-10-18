// Post-processing chain (pmndrs/postprocessing + N8AO):
//   RenderPass (HDR, half float)
//   → N8AO ambient occlusion (optional)
//   → [Atmosphere/volumetrics + exposure, Bloom, AgX tone mapping, Grading]
//   → SMAA (LDR) → screen

import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  KernelSize,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { AtmosphereEffect } from './AtmosphereEffect';
import { GradingEffect } from './GradingEffect';
import type { Atmosphere } from '../environment/Atmosphere';
import type { VolumeShadow } from './VolumeShadow';
import type { QualitySettings } from '../core/Quality';

export class PostFX {
  readonly composer: EffectComposer;
  readonly atmosphereEffect: AtmosphereEffect;
  readonly grading: GradingEffect;
  readonly bloom: BloomEffect;
  readonly toneMapping: ToneMappingEffect;
  private renderPass: RenderPass;
  private aoPass: N8AOPostPass;
  private mainPass: EffectPass | null = null;
  private smaaPass: EffectPass | null = null;
  private smaa: SMAAEffect;
  private quality: QualitySettings;
  bloomBase = 0.32;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    atmosphere: Atmosphere,
    volume: VolumeShadow,
    quality: QualitySettings,
  ) {
    this.quality = quality;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: quality.multisampling,
      stencilBuffer: false,
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.aoPass = new N8AOPostPass(scene, camera, size.x, size.y);
    const cfg = this.aoPass.configuration;
    cfg.aoRadius = 1.4;
    cfg.distanceFalloff = 1.0;
    cfg.intensity = 2.2;
    cfg.color = new THREE.Color(0, 0, 0);
    cfg.gammaCorrection = false;
    cfg.transparencyAware = false;
    cfg.halfRes = quality.aoHalfRes;
    this.aoPass.setQualityMode(quality.level === 'ultra' ? 'Medium' : 'Low');
    this.aoPass.enabled = quality.ao;
    this.composer.addPass(this.aoPass);

    this.atmosphereEffect = new AtmosphereEffect(atmosphere, camera, volume, quality.volumetricSteps);
    this.bloom = new BloomEffect({
      intensity: this.bloomBase,
      luminanceThreshold: 1.1,
      luminanceSmoothing: 0.35,
      mipmapBlur: true,
      radius: 0.72,
      levels: 7,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
    this.grading = new GradingEffect();
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.rebuild();
  }

  private rebuild(): void {
    if (this.mainPass) {
      this.composer.removePass(this.mainPass);
      this.mainPass.dispose();
    }
    if (this.smaaPass) {
      this.composer.removePass(this.smaaPass);
      this.smaaPass.dispose();
    }
    const effects = [this.atmosphereEffect, ...(this.quality.bloom ? [this.bloom] : []), this.toneMapping, this.grading];
    this.mainPass = new EffectPass(this.camera, ...effects);
    this.composer.addPass(this.mainPass);
    if (this.quality.smaa) {
      this.smaaPass = new EffectPass(this.camera, this.smaa);
      this.composer.addPass(this.smaaPass);
    } else {
      this.smaaPass = null;
    }
  }

  setQuality(q: QualitySettings): void {
    const prev = this.quality;
    this.quality = q;
    this.aoPass.enabled = q.ao;
    if (prev.aoHalfRes !== q.aoHalfRes) this.aoPass.configuration.halfRes = q.aoHalfRes;
    if (prev.level !== q.level) this.aoPass.setQualityMode(q.level === 'ultra' ? 'Medium' : 'Low');
    this.atmosphereEffect.setSteps(q.volumetricSteps);
    if (prev.multisampling !== q.multisampling) this.composer.multisampling = q.multisampling;
    if (prev.bloom !== q.bloom || prev.smaa !== q.smaa) this.rebuild();
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  setExposure(exposure: number): void {
    this.atmosphereEffect.u('uExposure').value = exposure;
    this.bloom.intensity = this.bloomBase * Math.min(exposure, 1.6);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
