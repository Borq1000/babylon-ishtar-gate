// Display-referred colour grading applied after tone mapping:
// gentle S-curve, saturation, split toning (cool shadows / warm highlights),
// soft vignette and a whisper of film grain. Deliberately restrained.

import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const fragment = /* glsl */ `
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uVignette;
uniform float uGrain;
uniform float uGradeFrame;
uniform float uBlackLift;
uniform float uNight;

float gradeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  vec3 g = pow(c, vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) * 0.5;
  g += uHighlightTint * smoothstep(0.45, 1.0, l) * 0.5;
  vec3 s = clamp(g, 0.0, 1.0);
  g = mix(g, s * s * (3.0 - 2.0 * s), uContrast);
  float l2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l2), g, uSaturation);
  // night: rod vision shifts the dim, moonlit tones towards a desaturated blue,
  // while the bright, firelit tones keep their warmth
  vec3 scot = vec3(l2) * vec3(0.8, 0.92, 1.16);
  g = mix(g, scot, uNight * 0.5 * (1.0 - smoothstep(0.22, 0.55, l2)));
  g = uBlackLift + g * (1.0 - uBlackLift);
  vec2 d = uv - 0.5;
  d.x *= aspect;
  float v = 1.0 - uVignette * smoothstep(0.32, 1.0, length(d) * 1.2);
  g *= v;
  float n = gradeHash(uv * resolution + mod(uGradeFrame, 97.0) * 13.17) - 0.5;
  g += n * uGrain * (0.6 + 0.4 * (1.0 - l2));
  outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
}
`;

export class GradingEffect extends Effect {
  private frame = 0;
  constructor() {
    super('GradingEffect', fragment, {
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, THREE.Uniform>([
        ['uContrast', new THREE.Uniform(0.18)],
        ['uSaturation', new THREE.Uniform(1.0)],
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3(-0.005, 0.002, 0.007))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(0.016, 0.006, -0.014))],
        ['uVignette', new THREE.Uniform(0.28)],
        ['uGrain', new THREE.Uniform(0.018)],
        ['uGradeFrame', new THREE.Uniform(0)],
        ['uBlackLift', new THREE.Uniform(0.004)],
        ['uNight', new THREE.Uniform(0)],
      ]),
    });
  }

  set(name: string, value: unknown): void {
    const u = this.uniforms.get(name);
    if (u) u.value = value;
  }

  override update(): void {
    this.uniforms.get('uGradeFrame')!.value = this.frame++ % 997;
  }
}
