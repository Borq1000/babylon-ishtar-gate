// Aerial perspective + volumetric sun shafts + exposure, as one post effect.
//
// * Exponential height fog with an analytic optical depth.
// * In-scattered colour = the analytic sky radiance at the horizon in the view
//   azimuth, so distant architecture melts into exactly the sky behind it.
// * The direct-sun share of that in-scattering is shadowed by ray-marching the
//   VolumeShadow depth map, which yields soft light shafts in the dusty air.

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { SKY_FUNCTIONS_GLSL, SKY_UNIFORMS_GLSL } from '../shaders/sky.glsl';
import type { Atmosphere } from '../environment/Atmosphere';
import type { VolumeShadow } from './VolumeShadow';

const fragment = /* glsl */ `
${SKY_UNIFORMS_GLSL}
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uSunShare;
uniform float uSunLobe;
uniform float uAmbientScatter;
uniform vec3 uKeyColor;
uniform vec3 uKeyDir;
uniform float uExposure;
uniform float uFrame;
uniform float uMarchDist;
uniform sampler2D uVolShadowMap;
uniform mat4 uVolShadowMatrix;
uniform float uVolShadowEnabled;
uniform float uGroundHaze;

${SKY_FUNCTIONS_GLSL}

float atmoIGN(vec2 p) {
  p += 5.588238 * mod(uFrame, 64.0);
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// optical depth from the camera along rd for distance s (analytic exponential height fog)
float atmoOD(float y0, float rdy, float s) {
  float H = uFogHeight;
  float base = uFogDensity * exp(-max(y0, 0.0) / H);
  float k = rdy / H;
  float od = abs(k) < 1e-5 ? s : (1.0 - exp(-k * s)) / k;
  // thin ground-hugging dust layer (scale height ~4 m)
  float Hg = 4.0;
  float kg = rdy / Hg;
  float baseG = uGroundHaze * exp(-max(y0, 0.0) / Hg);
  float odg = abs(kg) < 1e-5 ? s : (1.0 - exp(-kg * s)) / kg;
  return base * od + baseG * odg;
}

float atmoHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

float atmoShadow(vec3 p) {
  vec4 sp = uVolShadowMatrix * vec4(p, 1.0);
  if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0) return 1.0;
  float d = texture2D(uVolShadowMap, sp.xy).r;
  return sp.z - 0.0015 <= d ? 1.0 : 0.0;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 rd = normalize(wp - uCamPos);
  // only the cleared depth is sky: ground just inside the far plane must still get haze
  bool sky = depth >= 0.9999999;

  vec3 col = inputColor.rgb;
  if (!sky) {
    float s = length(wp - uCamPos);
    float y0 = uCamPos.y;
    float Ts = exp(-atmoOD(y0, rd.y, s));
    vec3 haze = skyRadiance(normalize(vec3(rd.x, 0.035, rd.z))) * uAmbientScatter;
    float cosT = dot(rd, uKeyDir);
    vec3 lobe = uKeyColor * atmoHG(cosT, 0.72) * uSunLobe;

    // fraction of in-scattering that is lit by the key light
    float litFrac = 1.0 - Ts;
#if VOL_STEPS > 0
    if (uVolShadowEnabled > 0.5) {
      float marchEnd = min(s, uMarchDist);
      float j = atmoIGN(gl_FragCoord.xy);
      float prevT = 1.0;
      float lit = 0.0;
      for (int i = 0; i < VOL_STEPS; i++) {
        float f = (float(i) + j) / float(VOL_STEPS);
        float t = marchEnd * f * f;
        float Tt = exp(-atmoOD(y0, rd.y, t));
        lit += atmoShadow(uCamPos + rd * t) * (prevT - Tt);
        prevT = Tt;
      }
      float Tend = exp(-atmoOD(y0, rd.y, marchEnd));
      lit += prevT - Tend; // remainder of the marched segment, assume lit
      lit += Tend - Ts;    // beyond the shadow map: lit
      litFrac = lit;
    }
#endif
    vec3 inscatter = haze * ((1.0 - uSunShare) * (1.0 - Ts) + uSunShare * litFrac) + lobe * litFrac;
    col = col * Ts + inscatter;
  }
  outputColor = vec4(col * uExposure, inputColor.a);
}
`;

export class AtmosphereEffect extends Effect {
  private camera: THREE.PerspectiveCamera;
  private frame = 0;
  private steps = -1;

  constructor(atmosphere: Atmosphere, camera: THREE.PerspectiveCamera, volume: VolumeShadow, steps: number) {
    const uniforms = new Map<string, THREE.Uniform>();
    for (const [k, v] of Object.entries(atmosphere.uniforms)) uniforms.set(k, v as THREE.Uniform);
    const own: Record<string, unknown> = {
      uInvProj: new THREE.Matrix4(),
      uCamWorld: new THREE.Matrix4(),
      uCamPos: new THREE.Vector3(),
      uFogDensity: 0.0009,
      uFogHeight: 200,
      uSunShare: 0.65,
      uSunLobe: 0.6,
      uAmbientScatter: 1,
      uKeyColor: new THREE.Color(1, 0.8, 0.6),
      uKeyDir: new THREE.Vector3(0, 1, 0),
      uExposure: 1,
      uFrame: 0,
      uMarchDist: 220,
      uGroundHaze: 0.0,
    };
    for (const [k, v] of Object.entries(own)) uniforms.set(k, new THREE.Uniform(v));
    uniforms.set('uVolShadowMap', volume.uniforms.uVolShadowMap);
    uniforms.set('uVolShadowMatrix', volume.uniforms.uVolShadowMatrix);
    uniforms.set('uVolShadowEnabled', volume.uniforms.uVolShadowEnabled);

    super('AtmosphereEffect', fragment, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SET,
      uniforms,
      defines: new Map([['VOL_STEPS', String(Math.max(0, steps | 0))]]),
    });
    this.camera = camera;
    this.steps = steps;
  }

  setSteps(steps: number): void {
    if (steps === this.steps) return;
    this.steps = steps;
    this.defines.set('VOL_STEPS', String(Math.max(0, steps | 0)));
    this.setChanged();
  }

  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }

  override update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, _dt?: number): void {
    const cam = this.camera;
    (this.u('uInvProj').value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (this.u('uCamWorld').value as THREE.Matrix4).copy(cam.matrixWorld);
    (this.u('uCamPos').value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
    this.u('uFrame').value = this.frame++ % 1024;
  }
}
