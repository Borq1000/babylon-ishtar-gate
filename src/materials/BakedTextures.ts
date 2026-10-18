// GPU-baked tiling PBR texture sets: glazed brick, buff baked brick,
// limestone & red-breccia paving, plus a macro-variation noise texture.

import * as THREE from 'three';
import { TextureBaker } from './TextureBaker';
import { NOISE_GLSL } from '../shaders/common.glsl';
import { BRICK_CONST_GLSL, BRICK_GLSL } from '../shaders/bricks.glsl';

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture; // r = AO, g = roughness, b = metalness, a = height
  tile: THREE.Vector2; // metres covered by one texture repeat
  heightScale: number; // metres represented by the full 0..1 height range
}

/** sRGB hex -> linear Color (as uniform). */
export const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const header = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTile;
uniform float uTexel;
uniform int uMode;
uniform float uHeightScale;
${NOISE_GLSL}
${BRICK_CONST_GLSL}
`;

function mainFor(heightExpr: string, albedoExpr: string): string {
  return /* glsl */ `
float H(vec2 p) { return ${heightExpr}; }
vec3 A(vec2 p, out float r, out float ao) { return ${albedoExpr}; }
void main() {
  vec2 p = vUv * uTile;
  if (uMode == 0) {
    float r, ao; vec3 c = A(p, r, ao);
    gl_FragColor = vec4(c, 1.0);
  } else if (uMode == 1) {
    float e = uTexel;
    float hx = H(p + vec2(e, 0.0)) - H(p - vec2(e, 0.0));
    float hy = H(p + vec2(0.0, e)) - H(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  } else {
    float r, ao; A(p, r, ao);
    float h = H(p);
    gl_FragColor = vec4(ao, clamp(r, 0.04, 1.0), 0.0, clamp(h / uHeightScale + 0.5, 0.0, 1.0));
  }
}`;
}

function bakeSet(
  baker: TextureBaker,
  name: string,
  size: number,
  tile: THREE.Vector2,
  heightScale: number,
  frag: string,
  extraUniforms: Record<string, THREE.IUniform>,
  anisotropy: number,
): PBRSet {
  const base = (mode: number) => ({
    uTile: { value: tile },
    uTexel: { value: tile.x / size },
    uMode: { value: mode },
    uHeightScale: { value: heightScale },
    ...extraUniforms,
  });
  const map = baker.bake({ width: size, height: size, fragmentShader: frag, uniforms: base(0), srgb: true, anisotropy, name: `${name}.albedo` });
  const normalMap = baker.bake({ width: size, height: size, fragmentShader: frag, uniforms: base(1), anisotropy, name: `${name}.normal` });
  const orm = baker.bake({ width: size, height: size, fragmentShader: frag, uniforms: base(2), anisotropy, name: `${name}.orm` });
  return { map, normalMap, orm, tile: tile.clone(), heightScale };
}

// Cobalt glaze of the Ishtar Gate. The fresh glaze is a deep ultramarine-cobalt
// that still carries some red: pure-blue albedos turn neon in skylit shade.
// A/B: the common tones, C: lighter bricks, D: dark navy bricks, E: rare greyish
// teal (thin or over-fired glaze). Keep in sync with GLAZE_BLUE in AnimalShapes.
export const GLAZE_PALETTE = {
  uGlazeA: { value: lin(0x203873) },
  uGlazeB: { value: lin(0x29478d) },
  uGlazeC: { value: lin(0x375f97) },
  uGlazeD: { value: lin(0x1a2a59) },
  uGlazeE: { value: lin(0x486478) },
  uGlazeEdge: { value: lin(0x8295ab) },
  uMortar: { value: lin(0x8c8474) },
  uClay: { value: lin(0xb9a58a) },
};

export const BUFF_PALETTE = {
  uBuffA: { value: lin(0xc9a978) },
  uBuffB: { value: lin(0xd8bf90) },
  uBuffC: { value: lin(0xa98463) },
  uBitumen: { value: lin(0x3f3730) },
};

// Light blue-turquoise ground of the lion register (Berlin / Met panels): a
// muted mix of teal, turquoise and blue-grey bricks. Keep in sync with GLAZE_TURQ.
export const TURQ_PALETTE = {
  uGlazeA: { value: lin(0x3a7896) },
  uGlazeB: { value: lin(0x468ea0) },
  uGlazeC: { value: lin(0x64a2a8) },
  uGlazeD: { value: lin(0x2f6188) },
  uGlazeE: { value: lin(0x7a948f) },
  uGlazeEdge: { value: lin(0xa3bcbf) },
  uMortar: { value: lin(0x958b7a) },
  uClay: { value: lin(0xb9a58a) },
};

export function bakeGlazedBrick(baker: TextureBaker, size: number, anisotropy: number, palette: Record<string, THREE.IUniform> = GLAZE_PALETTE): PBRSet {
  const frag =
    header +
    BRICK_GLSL +
    mainFor('glazedHeight(p, uTile / vec2(BR_L, BR_C), uTile)', 'glazedAlbedo(p, uTile / vec2(BR_L, BR_C), uTile, r, ao)');
  return bakeSet(baker, 'glazedBrick', size, new THREE.Vector2(2, 2), 0.016, frag, { ...BUFF_PALETTE, ...palette }, anisotropy);
}

export function bakeBuffBrick(baker: TextureBaker, size: number, anisotropy: number): PBRSet {
  const frag =
    header +
    BRICK_GLSL +
    mainFor('buffHeight(p, uTile / vec2(BR_L, BR_C), uTile)', 'buffAlbedo(p, uTile / vec2(BR_L, BR_C), uTile, r, ao)');
  return bakeSet(baker, 'buffBrick', size, new THREE.Vector2(2, 2), 0.02, frag, { ...GLAZE_PALETTE, ...BUFF_PALETTE }, anisotropy);
}

const PAVING_GLSL = /* glsl */ `
uniform vec3 uStoneA;
uniform vec3 uStoneB;
uniform vec3 uDirt;
uniform vec3 uJoint;
uniform float uSlab;

struct Slab { vec2 local; vec2 cell; float jd; float id; };
Slab slabAt(vec2 p, vec2 period) {
  Slab s;
  vec2 c = floor(p / uSlab);
  s.cell = mod(c, period);
  s.local = p - c * uSlab;
  vec2 d = min(s.local, vec2(uSlab) - s.local);
  float chip = (fbmP(p * 7.0, uTile * 7.0, 4) - 0.5) * 0.03;
  s.jd = min(d.x, d.y) - 0.006 + chip;
  s.id = hash12(s.cell + 0.5);
  return s;
}

float limeHeightSlab(vec2 p, Slab s);
float limeHeight(vec2 p) {
  // single exit (early returns after loops make ANGLE's HLSL backend warn)
  Slab s = slabAt(p, uTile / uSlab);
  float h = -0.012 + fbmP(p * 60.0, uTile * 60.0, 3) * 0.004;
  if (s.jd >= 0.0) h = limeHeightSlab(p, s);
  return h;
}
float limeHeightSlab(vec2 p, Slab s) {
  float bevel = sqrt(smoothstep(0.0, 0.02, s.jd));
  vec2 tilt = (hash22(s.cell + 4.4) - 0.5) * 0.008;
  float settle = dot(s.local - uSlab * 0.5, tilt);
  float surf = (fbmP(p * 22.0 + s.id * 9.0, uTile * 22.0, 5) - 0.5) * 0.0025;
  float pits = -smoothstep(0.72, 0.85, fbmP(p * 70.0 + 5.0, uTile * 70.0, 3)) * 0.0018;
  return bevel * (0.002 + settle + surf + pits);
}
vec3 limeAlbedo(vec2 p, out float r, out float ao) {
  Slab s = slabAt(p, uTile / uSlab);
  float n = fbmP(p * 6.0 + s.id * 11.0, uTile * 6.0, 5);
  float n2 = fbmP(p * 40.0, uTile * 40.0, 3);
  if (s.jd < 0.0) {
    r = 0.55; ao = 0.45 + 0.35 * smoothstep(-0.012, -0.002, s.jd);
    return mix(uJoint, uDirt, 0.25 * n2);
  }
  vec3 col = mix(uStoneA, uStoneB, smoothstep(0.1, 0.95, s.id));
  col *= 0.8 + 0.34 * n;
  col *= 0.92 + 0.16 * n2;
  // a few slabs are pinker or greyer (different quarry beds)
  col = mix(col, col * vec3(1.06, 0.95, 0.88), step(0.82, hash12(s.cell + 9.7)));
  col = mix(col, col * vec3(0.9, 0.92, 0.95), step(0.88, hash12(s.cell + 4.1)));
  // dirt creeping in from the joints
  float edgeDirt = 1.0 - smoothstep(0.0, 0.06 + 0.05 * n, s.jd);
  col = mix(col, uDirt, edgeDirt * 0.45);
  // faint veins
  float vein = smoothstep(0.03, 0.0, abs(fbmP(p * 3.0 + s.id * 4.0, uTile * 3.0, 5) - 0.5));
  col *= 1.0 - vein * 0.12;
  // worn, slightly polished centres of the slabs
  vec2 lc = s.local / uSlab - 0.5;
  float worn = 1.0 - smoothstep(0.15, 0.5, length(lc));
  r = 0.66 + 0.16 * n2 + edgeDirt * 0.2 - worn * 0.18;
  ao = 1.0 - edgeDirt * 0.2;
  return col;
}

// red breccia: angular clasts in a red-brown matrix
float brecHeightSlab(vec2 p, Slab s);
float brecHeight(vec2 p) {
  Slab s = slabAt(p, uTile / uSlab);
  float h = -0.01 + fbmP(p * 60.0, uTile * 60.0, 3) * 0.004;
  if (s.jd >= 0.0) h = brecHeightSlab(p, s);
  return h;
}
float brecHeightSlab(vec2 p, Slab s) {
  float bevel = sqrt(smoothstep(0.0, 0.015, s.jd));
  vec3 v = voronoiP(p * 7.0 + s.id * 3.0, uTile * 7.0);
  float clast = smoothstep(0.012, 0.05, v.y - v.x);
  vec2 tilt = (hash22(s.cell + 7.7) - 0.5) * 0.007;
  return bevel * (0.0018 + clast * 0.0006 + dot(s.local - uSlab * 0.5, tilt) + (fbmP(p * 30.0, uTile * 30.0, 4) - 0.5) * 0.002);
}
vec3 brecAlbedo(vec2 p, out float r, out float ao) {
  Slab s = slabAt(p, uTile / uSlab);
  float n2 = fbmP(p * 40.0, uTile * 40.0, 3);
  if (s.jd < 0.0) {
    r = 0.55; ao = 0.45 + 0.35 * smoothstep(-0.01, -0.002, s.jd);
    return mix(uJoint, uDirt, 0.25 * n2);
  }
  // large angular red clasts, smaller ones, and white calcite veins along their borders
  vec3 v = voronoiP(p * 7.0 + s.id * 3.0, uTile * 7.0);
  vec3 v2 = voronoiP(p * 19.0 + 1.7, uTile * 19.0);
  float vein = 1.0 - smoothstep(0.012, 0.05, v.y - v.x);
  float vein2 = (1.0 - smoothstep(0.01, 0.035, v2.y - v2.x)) * step(0.45, v2.z);
  vec3 c1 = mix(vec3(0.36, 0.11, 0.07), vec3(0.5, 0.2, 0.12), v.z);
  c1 = mix(c1, vec3(0.28, 0.09, 0.07), step(0.8, v.z));
  c1 = mix(c1, vec3(0.55, 0.32, 0.24), step(0.92, v.z));
  vec3 col = mix(c1, c1 * vec3(1.15, 0.95, 0.9), v2.z * 0.5);
  col = mix(col, vec3(0.7, 0.62, 0.55), vein * 0.6);
  col = mix(col, vec3(0.62, 0.53, 0.46), vein2 * 0.35);
  col *= 0.88 + 0.24 * n2;
  col *= 0.9 + 0.2 * s.id;
  // weathered, dusty surface: less saturated than a polished museum sample
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 0.78);
  float edgeDirt = 1.0 - smoothstep(0.0, 0.05, s.jd);
  col = mix(col, uDirt, edgeDirt * 0.35);
  r = 0.45 + 0.2 * n2 + edgeDirt * 0.2 + vein * 0.05;
  ao = 1.0 - edgeDirt * 0.2;
  return col;
}
`;

export function bakeLimestonePaving(baker: TextureBaker, size: number, anisotropy: number): PBRSet {
  const frag = header + PAVING_GLSL + mainFor('limeHeight(p)', 'limeAlbedo(p, r, ao)');
  return bakeSet(baker, 'limestone', size, new THREE.Vector2(4.2, 4.2), 0.03, frag, {
    uStoneA: { value: lin(0xd8c9a6) },
    uStoneB: { value: lin(0xbfa982) },
    uDirt: { value: lin(0xa48a63) },
    uJoint: { value: lin(0x2e2722) },
    uSlab: { value: 1.05 },
  }, anisotropy);
}

export function bakeBrickPaving(baker: TextureBaker, size: number, anisotropy: number): PBRSet {
  const frag = header + PAVING_GLSL + mainFor('limeHeight(p)', 'limeAlbedo(p, r, ao)');
  return bakeSet(baker, 'brickPave', size, new THREE.Vector2(2, 2), 0.03, frag, {
    uStoneA: { value: lin(0xc09c6a) },
    uStoneB: { value: lin(0xa9845a) },
    uDirt: { value: lin(0xa08868) },
    uJoint: { value: lin(0x2e2722) },
    uSlab: { value: 1 / 3 },
  }, anisotropy);
}

export function bakeBrecciaPaving(baker: TextureBaker, size: number, anisotropy: number): PBRSet {
  const frag = header + PAVING_GLSL + mainFor('brecHeight(p)', 'brecAlbedo(p, r, ao)');
  return bakeSet(baker, 'breccia', size, new THREE.Vector2(1.98, 1.98), 0.03, frag, {
    uStoneA: { value: lin(0x8a3a2c) },
    uStoneB: { value: lin(0x9a4a38) },
    uDirt: { value: lin(0x9a8466) },
    uJoint: { value: lin(0x2e2722) },
    uSlab: { value: 0.66 },
  }, anisotropy);
}

/** Tileable macro noise: r,g = two fbm octaves sets, b = voronoi-ish blotches, a = fine. */
export function bakeMacroNoise(baker: TextureBaker, size = 512): THREE.Texture {
  const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = vUv;
  float a = fbmP(p * 4.0, vec2(4.0), 6);
  float b = fbmP(p * 9.0 + 3.0, vec2(9.0), 5);
  vec3 v = voronoiP(p * 6.0, vec2(6.0));
  float c = smoothstep(0.0, 0.6, v.x);
  float d = fbmP(p * 32.0 + 7.0, vec2(32.0), 4);
  gl_FragColor = vec4(a, b, c, d);
}`;
  return baker.bake({ width: size, height: size, fragmentShader: frag, name: 'macroNoise' });
}
