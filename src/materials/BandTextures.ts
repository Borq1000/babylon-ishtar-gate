// Glazed ornamental bands (GPU-baked, tiling horizontally every 2 m):
//   rosette  — white daisies with orange hearts on deep blue (4 courses)
//   checker  — ochre-yellow courses with black|white|black inserts (2 courses)
//   yellow   — plain ochre-yellow glazed courses (1 course)
//   border   — vertical frame strip used on tower edges and around the arch
// They share the brick layout with the walls so joints line up.

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/common.glsl';
import { BRICK_CONST_GLSL, BRICK_GLSL } from '../shaders/bricks.glsl';
import { GLAZE_PALETTE, BUFF_PALETTE, lin, type PBRSet } from './BakedTextures';
import type { TextureBaker } from './TextureBaker';

export type BandKind = 'rosette' | 'checker' | 'yellow' | 'border' | 'merlonBand' | 'vborder';

export const BAND_COURSES: Record<BandKind, number> = {
  rosette: 4,
  checker: 2,
  yellow: 1,
  border: 6,
  merlonBand: 3,
  vborder: 24,
};

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTile;
uniform float uTexel;
uniform int uMode;
uniform int uKind;
uniform float uHeightScale;
uniform vec3 uYellow;
uniform vec3 uYellowB;
uniform vec3 uYellowC;
uniform vec3 uWhite;
uniform vec3 uHeart;
uniform vec3 uBlack;
uniform vec3 uGreen;
uniform vec3 uDeep;
${NOISE_GLSL}
${BRICK_CONST_GLSL}
${BRICK_GLSL}

// rosette signed field: returns (height, colourId) with colourId 0 = background, 1 = petal, 2 = heart, 3 = line
// Rosette as on the Berlin friezes: ten white petals around a large yellow
// heart; petals are separated by fine incisions (colour id 4 = soft groove),
// only the heart has a thin dark ring.
vec2 rosette(vec2 p, vec2 c, float R) {
  vec2 d = p - c;
  float r = length(d) / R;
  float a = atan(d.y, d.x);
  float n = 10.0;
  float petalR = 0.78 + 0.22 * pow(abs(cos(n * a * 0.5)), 0.6);
  if (r > petalR) return vec2(0.0, 0.0);
  if (r < 0.4) {
    if (r > 0.36) return vec2(0.0055, 3.0);
    return vec2(0.0068 + 0.0018 * (1.0 - r / 0.4), 2.0);
  }
  float sep = abs(sin(n * a * 0.5));
  float edge = petalR - r;
  float dome = smoothstep(0.0, 0.22, edge) * (1.0 - 0.6 * pow(sep, 6.0));
  // incised separations between the petals and a thin outline around them
  if (sep < 0.07 * (0.6 + r) || edge < 0.035) return vec2(0.0018 + 0.001 * dome, 4.0);
  return vec2(0.0026 + 0.0024 * dome, 1.0);
}

float bandRow(vec2 p) { return floor(p.y / BR_C); }

// evaluates the band: returns height and writes colour / roughness / ao
float bandEval(vec2 p, out vec3 col, out float rough, out float ao) {
  vec2 period = uTile / vec2(BR_L, BR_C);
  Brick b = brickAt(p, period);
  float row = bandRow(p);
  float r0, a0;
  // base glaze per kind
  vec3 base;
  if (uKind == 0 || uKind == 4) {
    base = glazedAlbedo(p, period, uTile, r0, a0);
    base = mix(base, base * vec3(0.8, 0.85, 1.05), 0.35);
  } else {
    // ochre glaze: every brick fired a little differently, from orange to pale
    // straw (Berlin frieze), with glaze pooling inside the brick
    float m = 0.86 + 0.28 * fbmP(p * 26.0 + b.id * 4.0, uTile * 26.0, 3);
    base = mix(uYellow, uYellowB, smoothstep(0.1, 0.9, b.id));
    base = mix(base, uYellowC, smoothstep(0.78, 0.98, b.id2) * 0.8);
    base *= m * (0.9 + 0.2 * hash12(b.cell + 5.1));
    r0 = 0.22 + 0.12 * b.id2;
    a0 = 1.0;
  }
  float h = glazedHeight(p, period, uTile);
  col = base;
  rough = r0;
  ao = a0;
  if (b.jd < 0.0) return h; // joints stay mortar

  if (uKind == 0) {
    // rosettes every 0.5 m (4 per 2 m tile), centred in the 4-course band
    float cellW = 0.5;
    vec2 c = vec2((floor(p.x / cellW) + 0.5) * cellW, uTile.y * 0.5);
    vec2 rs = rosette(p, c, 0.128);
    if (rs.y > 0.5) {
      h += rs.x;
      vec3 petal = uWhite * (0.92 + 0.1 * b.id);
      col = rs.y < 1.5 ? petal : rs.y < 2.5 ? uHeart * (0.88 + 0.16 * b.id2) : rs.y < 3.5 ? uBlack : mix(petal, uBlack, 0.62);
      rough = 0.24 + 0.1 * b.id2;
    }
  } else if (uKind == 1) {
    // inserts in the upper course: black | white | black, centred on each brick
    if (row > 0.5) {
      float lx = b.local.x - BR_L * 0.5;
      if (abs(lx) < 0.05) {
        col = abs(lx) < 0.017 ? uWhite : uBlack;
        h += 0.0006;
      }
    }
  } else if (uKind == 3) {
    // vertical frame strip seen horizontally: [green][yellow][checker][yellow][green][deep]
    float t = p.y / uTile.y; // across the strip (0..1)
    if (t < 0.12 || (t > 0.66 && t < 0.78)) col = uGreen * (0.9 + 0.15 * b.id);
    else if (t > 0.86) col = glazedAlbedo(p, period, uTile, r0, a0);
    else if (t > 0.3 && t < 0.48) {
      float k = step(0.5, fract(p.x / 0.1));
      col = mix(uBlack, uWhite, k);
    }
  } else if (uKind == 5) {
    // vertical frame strip (0.5 m wide): horizontal courses, colour stripes across x
    float t = p.x / uTile.x;
    if (t < 0.14 || t > 0.86) col = uGreen * (0.9 + 0.15 * b.id);
    else if (t > 0.42 && t < 0.58) {
      float k = step(0.5, fract(p.y / (BR_C * 2.0)));
      col = mix(uBlack, uWhite, k);
    }
  } else if (uKind == 4) {
    // band under the crenellations: a yellow course, white dots, yellow course
    if (row < 0.5 || row > 1.5) col = mix(uYellow, uYellowB, b.id);
    else {
      float cx = (floor(p.x / (BR_L * 0.5)) + 0.5) * BR_L * 0.5;
      float rr = length(vec2(p.x - cx, p.y - (row + 0.5) * BR_C)) / 0.026;
      if (rr < 1.0) { col = uWhite; h += 0.002 * (1.0 - rr * rr); }
    }
  }
  return h;
}

void main() {
  vec2 p = vUv * uTile;
  vec3 col; float rough; float ao;
  if (uMode == 0) {
    bandEval(p, col, rough, ao);
    gl_FragColor = vec4(col, 1.0);
  } else if (uMode == 1) {
    float e = uTexel;
    vec3 c2; float r2; float a2;
    float hx = bandEval(p + vec2(e, 0.0), c2, r2, a2) - bandEval(p - vec2(e, 0.0), c2, r2, a2);
    float hy = bandEval(p + vec2(0.0, e), c2, r2, a2) - bandEval(p - vec2(0.0, e), c2, r2, a2);
    vec3 n = normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  } else {
    float h = bandEval(p, col, rough, ao);
    gl_FragColor = vec4(ao, clamp(rough, 0.04, 1.0), 0.0, clamp(h / uHeightScale + 0.5, 0.0, 1.0));
  }
}
`;

const KIND_ID: Record<BandKind, number> = { rosette: 0, checker: 1, yellow: 2, border: 3, merlonBand: 4, vborder: 5 };

export const BAND_COLORS = {
  uYellow: { value: lin(0xc98a35) },
  uYellowB: { value: lin(0xd9aa48) },
  uYellowC: { value: lin(0xd8c08a) },
  uWhite: { value: lin(0xece3cf) },
  uHeart: { value: lin(0xd6a03c) },
  uBlack: { value: lin(0x221a14) },
  uGreen: { value: lin(0x3f8f6c) },
  uDeep: { value: lin(0x1c3f8f) },
};

export function bakeBand(baker: TextureBaker, kind: BandKind, pxPerMetre: number, anisotropy: number): PBRSet {
  const courses = BAND_COURSES[kind];
  const tile = kind === 'vborder' ? new THREE.Vector2(0.5, 2) : new THREE.Vector2(2, courses * (1 / 12));
  const w = Math.round(tile.x * pxPerMetre);
  const h = Math.max(8, Math.round(tile.y * pxPerMetre));
  const heightScale = 0.024;
  const base = (mode: number) => ({
    uTile: { value: tile },
    uTexel: { value: tile.x / w },
    uMode: { value: mode },
    uKind: { value: KIND_ID[kind] },
    uHeightScale: { value: heightScale },
    ...GLAZE_PALETTE,
    ...BUFF_PALETTE,
    ...BAND_COLORS,
  });
  const opts = { width: w, height: h, fragmentShader: frag, anisotropy };
  const map = baker.bake({ ...opts, uniforms: base(0), srgb: true, name: `band.${kind}.albedo` });
  const normalMap = baker.bake({ ...opts, uniforms: base(1), name: `band.${kind}.normal` });
  const orm = baker.bake({ ...opts, uniforms: base(2), name: `band.${kind}.orm` });
  for (const t of [map, normalMap, orm]) {
    t.wrapS = kind === 'vborder' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapT = kind === 'vborder' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  }
  return { map, normalMap, orm, tile, heightScale };
}
