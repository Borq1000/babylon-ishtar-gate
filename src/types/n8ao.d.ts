// Minimal typings for n8ao (the package ships plain JS).
declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: Color;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    gammaCorrection: boolean;
    transparencyAware: boolean;
    screenSpaceRadius: boolean;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    accumulate: boolean;
    biasOffset: number;
    biasMultiplier: number;
    [key: string]: unknown;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra' | string): void;
    setSize(width: number, height: number): void;
  }
}
