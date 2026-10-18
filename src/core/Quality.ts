// Graphics quality presets. Everything that scales with GPU cost is driven from here.

export type QualityLevel = 'low' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  /** Cap on devicePixelRatio. */
  pixelRatioMax: number;
  /** Dynamic resolution bounds (multiplied with the pixel ratio). */
  renderScaleMin: number;
  renderScaleMax: number;
  /** Per-cascade shadow map size (two cascades in one atlas). */
  shadowMapSize: number;
  /** Max shadow distance in metres. */
  shadowDistance: number;
  shadowRadius: number;
  ao: boolean;
  aoHalfRes: boolean;
  aoSamples: number;
  /** Ray-march steps for volumetric sun shafts (0 = analytic haze only). */
  volumetricSteps: number;
  bloom: boolean;
  smaa: boolean;
  multisampling: number;
  /** Fraction of the dust particle pool that is drawn. */
  dustFraction: number;
  /** Fraction of the crowd that is simulated & drawn. */
  crowdFraction: number;
  /** Distance (m) under which relief panels use the full-resolution displaced mesh. */
  reliefNear: number;
  /** Distance (m) under which relief panels use the medium mesh (flat quad beyond). */
  reliefMid: number;
  /** Max anisotropic filtering. */
  anisotropy: number;
  /** Relief self-shadow ray-march steps. */
  reliefShadowSteps: number;
  /** Fraction of distant city instances drawn. */
  cityFraction: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    pixelRatioMax: 1,
    renderScaleMin: 0.6,
    renderScaleMax: 0.85,
    shadowMapSize: 1024,
    shadowDistance: 140,
    shadowRadius: 2,
    ao: false,
    aoHalfRes: true,
    aoSamples: 8,
    volumetricSteps: 0,
    bloom: false,
    smaa: true,
    multisampling: 0,
    dustFraction: 0.35,
    crowdFraction: 0.5,
    reliefNear: 14,
    reliefMid: 45,
    anisotropy: 4,
    reliefShadowSteps: 6,
    cityFraction: 0.55,
  },
  high: {
    level: 'high',
    pixelRatioMax: 1.25,
    renderScaleMin: 0.7,
    renderScaleMax: 1.0,
    shadowMapSize: 2048,
    shadowDistance: 220,
    shadowRadius: 3,
    ao: true,
    aoHalfRes: true,
    aoSamples: 12,
    volumetricSteps: 20,
    bloom: true,
    smaa: true,
    multisampling: 0,
    dustFraction: 0.75,
    crowdFraction: 1,
    reliefNear: 24,
    reliefMid: 80,
    anisotropy: 8,
    reliefShadowSteps: 12,
    cityFraction: 1,
  },
  ultra: {
    level: 'ultra',
    pixelRatioMax: 2,
    renderScaleMin: 0.8,
    renderScaleMax: 1.0,
    shadowMapSize: 4096,
    shadowDistance: 320,
    shadowRadius: 3,
    ao: true,
    aoHalfRes: false,
    aoSamples: 16,
    volumetricSteps: 36,
    bloom: true,
    smaa: true,
    multisampling: 4,
    dustFraction: 1,
    crowdFraction: 1,
    reliefNear: 40,
    reliefMid: 130,
    anisotropy: 16,
    reliefShadowSteps: 20,
    cityFraction: 1,
  },
};

/** Picks a sensible default from the GPU string (very rough heuristic). */
export function guessQuality(gl: WebGL2RenderingContext | null): QualityLevel {
  if (!gl) return 'low';
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    /* ignore */
  }
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 'low';
  if (/intel|uhd|iris|mali|adreno|powervr|apple m1\b/.test(r) && !/arc/.test(r)) return 'low';
  if (/rtx (40|50)[6-9]0|rtx 30[7-9]0|rx 7[89]00|rx 69|apple m[2-4] (pro|max|ultra)/.test(r)) return 'ultra';
  return 'high';
}
