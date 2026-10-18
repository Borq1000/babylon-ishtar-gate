// Atmospheric sky model shared by the sky dome, the environment-map capture
// and the aerial-perspective post effect (so distant geometry fades into
// exactly the colour of the sky behind it).
//
// Day sky: Preetham et al. analytic model (adapted from three.js Sky.js, MIT).
// Night sky: artistic gradient + stars + moon glow.

import { NOISE_GLSL } from './common.glsl';

export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uSunE;
uniform float uMieG;
uniform float uSkyScale;
uniform float uNight;
uniform vec3 uMoonDir;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;
uniform vec3 uHazeTint;
`;

export const SKY_FUNCTIONS_GLSL = /* glsl */ `
const float SKY_PI = 3.141592653589793;

vec3 skyPreetham(vec3 direction, out vec3 Fex) {
  float zenithAngle = acos(max(0.0, direction.y));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / SKY_PI), -1.253));
  float sR = 8.4E3 * inv;
  float sM = 1.25E3 * inv;
  Fex = exp(-(uBetaR * sR + uBetaM * sM));
  float cosTheta = dot(direction, uSunDir);
  float rc = cosTheta * 0.5 + 0.5;
  float rPhase = 0.05968310365946075 * (1.0 + rc * rc);
  vec3 betaRTheta = uBetaR * rPhase;
  float g2 = uMieG * uMieG;
  float mPhase = 0.07957747154594767 * ((1.0 - g2) / pow(max(1.0 - 2.0 * uMieG * cosTheta + g2, 1e-4), 1.5));
  vec3 betaMTheta = uBetaM * mPhase;
  vec3 ratio = (betaRTheta + betaMTheta) / (uBetaR + uBetaM);
  vec3 Lin = pow(max(uSunE * ratio * (1.0 - Fex), vec3(0.0)), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(max(uSunE * ratio * Fex, vec3(0.0)), vec3(0.5)), clamp(pow(1.0 - uSunDir.y, 5.0), 0.0, 1.0));
  vec3 L0 = vec3(0.1) * Fex;
  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  return pow(texColor, vec3(1.0 / 2.4));
}

// Daylight + night sky radiance (no sun disc, no clouds). Used for haze colour too.
vec3 skyRadiance(vec3 dir) {
  vec3 Fex;
  vec3 d = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z));
  vec3 day = skyPreetham(d, Fex) * uSkyScale * uHazeTint;
  float h = max(dir.y, 0.0);
  vec3 night = mix(uNightHorizon, uNightZenith, pow(h, 0.45));
  float cm = max(dot(d, uMoonDir), 0.0);
  night += vec3(0.55, 0.65, 0.9) * (0.25 * pow(cm, 8.0) + 0.9 * pow(cm, 90.0)) * uNightZenith * 6.0;
  return day + night * uNight;
}
`;

/** Full sky dome fragment shader (with sun disc, stars, moon, cirrus). */
export const skyVertexShader = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // push to far plane
}
`;

export const skyFragmentShader = /* glsl */ `
${SKY_UNIFORMS_GLSL}
uniform float uTime;
uniform vec3 uSunDiskColor;
uniform float uCloudCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uGroundMode;
uniform vec3 uGroundColor;
uniform float uStarIntensity;
varying vec3 vWorldDir;

${NOISE_GLSL}
${SKY_FUNCTIONS_GLSL}

float starField(vec3 dir) {
  vec3 p = dir * 320.0;
  vec3 c = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(c);
  if (h < 0.9962) return 0.0;
  vec3 o = (hash33(c + 3.1) - 0.5) * 0.55;
  float d = length(f - o);
  float b = smoothstep(0.16, 0.0, d);
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 6.0 * hash11(h * 91.0)) + h * 400.0);
  return b * tw * (0.25 + 3.0 * pow(hash11(h * 13.7), 6.0));
}

float milkyWay(vec3 dir) {
  // a soft band along a tilted great circle
  vec3 axis = normalize(vec3(0.35, 0.55, -0.76));
  float band = exp(-pow(dot(dir, axis) / 0.22, 2.0));
  float n = fbm(vec2(atan(dir.z, dir.x) * 6.0, dir.y * 9.0), 5);
  return band * (0.35 + 0.65 * n);
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 col = skyRadiance(dir);
  vec3 Fex;
  vec3 dh = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z));
  skyPreetham(dh, Fex);

  // high cirrus streaks, lit by the sun
  if (uCloudCover > 0.001 && dir.y > 0.0) {
    vec2 p = dir.xz / (dir.y + 0.12);
    p = mat2(0.8, -0.6, 0.6, 0.8) * p;
    p += vec2(uTime * 0.0035, uTime * 0.0012);
    float n = fbm(p * vec2(0.55, 2.2), 6);
    float n2 = fbm(p * vec2(1.7, 5.0) + 3.0, 4);
    float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.38, n * 0.8 + n2 * 0.35);
    c *= smoothstep(0.0, 0.18, dir.y);
    float toSun = pow(max(dot(dir, uSunDir), 0.0), 6.0);
    vec3 cl = mix(uCloudShade, uCloudLit, 0.55 + 0.45 * toSun);
    col = mix(col, cl, c * 0.75);
  }

  // sun disc (slightly larger than real for readability)
  float cosTheta = dot(dir, uSunDir);
  float disk = smoothstep(0.999955, 0.999985, cosTheta);
  col += uSunDiskColor * Fex * disk * (1.0 - uNight);

  // night: stars, milky way, moon disc
  if (uNight > 0.001) {
    float horizonFade = smoothstep(0.0, 0.25, dir.y);
    col += vec3(0.85, 0.9, 1.0) * starField(dir) * uStarIntensity * horizonFade * uNight;
    col += vec3(0.5, 0.55, 0.7) * milkyWay(dir) * 0.012 * horizonFade * uNight;
    float cm = dot(dir, uMoonDir);
    float moon = smoothstep(0.99985, 0.99992, cm);
    // faint maria
    float maria = 0.8 + 0.2 * vnoise(dir.xy * 900.0);
    col += vec3(1.0, 0.97, 0.9) * moon * 1.6 * maria * uNight;
  }

  // below the horizon: haze (visible dome) or ground bounce (env capture)
  if (dir.y < 0.0) {
    float g = smoothstep(0.0, -0.08, dir.y);
    col = mix(col, uGroundColor, g * uGroundMode);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;
