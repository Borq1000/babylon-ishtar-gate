// Babylonian brick-work generators (GLSL), shared by tiling wall textures and
// by the relief panels so their backgrounds match the walls exactly.
//
// Glazed façade bricks show their 33 cm × ~9 cm edge faces, laid in running bond.
// Module (brick + joint): L = 1/3 m, C = 1/12 m  ->  a 2 m × 2 m tile holds 6 × 24.

export const BRICK_CONST_GLSL = /* glsl */ `
const float BR_L = 0.33333333;
const float BR_C = 0.083333333;
const float BR_J = 0.0055;
`;

export const BRICK_GLSL = /* glsl */ `
struct Brick {
  vec2 local;     // position inside the brick module (m)
  vec2 cell;      // periodic cell index
  float jd;       // signed distance to the joint edge (m); < 0 inside joint
  float id;       // random [0,1)
  float id2;
  vec2 uvb;       // normalized position on brick face [0,1]
};

Brick brickAt(vec2 p, vec2 periodCells) {
  Brick b;
  float row = floor(p.y / BR_C);
  float off = mod(row, 2.0) * 0.5 * BR_L;
  float col = floor((p.x + off) / BR_L);
  b.cell = vec2(mod(col, periodCells.x), mod(row, periodCells.y));
  b.local = vec2(p.x + off - col * BR_L, p.y - row * BR_C);
  vec2 d = min(b.local, vec2(BR_L, BR_C) - b.local);
  b.jd = min(d.x, d.y) - BR_J * 0.5;
  b.id = hash12(b.cell * 1.37 + 0.71);
  b.id2 = hash12(b.cell * 2.11 + 5.3);
  b.uvb = clamp((b.local - BR_J * 0.5) / (vec2(BR_L, BR_C) - BR_J), 0.0, 1.0);
  return b;
}

// ---------- glazed brick ----------
uniform vec3 uGlazeA;
uniform vec3 uGlazeB;
uniform vec3 uGlazeC;
uniform vec3 uGlazeD;
uniform vec3 uGlazeE;
uniform vec3 uGlazeEdge;
uniform vec3 uMortar;
uniform vec3 uClay;

// (single-exit functions: early returns after loops make ANGLE's HLSL backend warn)
float glazedHeight(vec2 p, vec2 period, vec2 periodN) {
  Brick b = brickAt(p, period);
  float h = 0.0;
  if (b.jd < 0.0) {
    float m = fbmP(p * 120.0, periodN * 120.0, 3);
    h = -0.0045 + m * 0.0015;
  } else {
    float bevel = sqrt(smoothstep(0.0, 0.0045, b.jd));
    vec2 c = b.uvb * 2.0 - 1.0;
    float pillow = (1.0 - c.x * c.x * 0.6) * (1.0 - c.y * c.y * 0.8);
    vec2 tilt = (hash22(b.cell + 9.1) - 0.5) * vec2(0.010, 0.022);
    float t = dot(b.local - vec2(BR_L, BR_C) * 0.5, tilt);
    float ripple = (fbmP(p * 60.0, periodN * 60.0, 3) - 0.5) * 0.0005;
    float crawl = smoothstep(0.87, 0.9, fbmP(p * 16.0 + b.id * 7.0, periodN * 16.0, 4) + b.id2 * 0.04) * 0.0012;
    h = bevel * (0.0018 + pillow * 0.0009 + t + ripple - crawl);
  }
  return h;
}

vec3 glazedAlbedo(vec2 p, vec2 period, vec2 periodN, out float rough, out float ao) {
  Brick b = brickAt(p, period);
  rough = 0.9;
  ao = 1.0;
  vec3 col = uMortar;
  if (b.jd < 0.0) {
    float m = fbmP(p * 80.0, periodN * 80.0, 3);
    ao = 0.62 + 0.25 * smoothstep(-0.0055, -0.001, b.jd);
    col = uMortar * (0.82 + 0.36 * m);
  } else {
  // Per-brick glaze colour. Bricks were fired in batches, so neighbours share a
  // tone (low-frequency "batch" field over the brick grid); on top of that a few
  // lighter, darker and greyish-teal bricks, as on the excavated façades.
  float batch = vnoiseP(b.cell / vec2(3.0, 6.0), period / vec2(3.0, 6.0));
  float t = clamp(b.id * 0.7 + batch * 0.55 - 0.12, 0.0, 1.0);
  col = mix(uGlazeA, uGlazeB, smoothstep(0.15, 0.85, t));
  col = mix(col, uGlazeC, smoothstep(0.88, 0.97, b.id2) * 0.65);
  col = mix(col, uGlazeD, (1.0 - smoothstep(0.04, 0.08, b.id2)) * 0.7);
  col = mix(col, uGlazeE, step(0.985, hash12(b.cell + 7.7)) * 0.6);
  col *= 0.93 + 0.14 * hash12(b.cell + 3.3);
  // glaze pooling: broad soft clouds plus a fine speckle
  float mott = fbmP(p * 22.0 + b.id * 5.0, periodN * 22.0, 4);
  col *= 0.84 + 0.32 * mott;
  col *= 0.95 + 0.1 * fbmP(p * 140.0, periodN * 140.0, 2);
  // thinner, paler glaze on the arrises
  float edge = 1.0 - smoothstep(0.0, 0.007, b.jd);
  col = mix(col, uGlazeEdge, edge * 0.32);
  // rare crawled spots where the buff body shows through
  float crawl = smoothstep(0.87, 0.9, fbmP(p * 16.0 + b.id * 7.0, periodN * 16.0, 4) + b.id2 * 0.04);
  col = mix(col, uClay, crawl * 0.6);
  rough = 0.11 + 0.1 * b.id2 + 0.1 * (1.0 - mott) + edge * 0.1 + crawl * 0.5;
  ao = 1.0 - edge * 0.1;
  }
  return col;
}

// ---------- unglazed buff baked brick (bitumen mortar) ----------
uniform vec3 uBuffA;
uniform vec3 uBuffB;
uniform vec3 uBuffC;
uniform vec3 uBitumen;

float buffHeight(vec2 p, vec2 period, vec2 periodN) {
  Brick b = brickAt(p, period);
  float chip = (fbmP(p * 40.0 + b.id * 3.0, periodN * 40.0, 4) - 0.5) * 0.006;
  float jd = b.jd + chip;
  float h = 0.0;
  if (jd < 0.0) {
    h = -0.007 + fbmP(p * 90.0, periodN * 90.0, 3) * 0.003;
  } else {
    float bevel = sqrt(smoothstep(0.0, 0.007, jd));
    float grain = (fbmP(p * 150.0, periodN * 150.0, 3) - 0.5) * 0.0012;
    float pits = -smoothstep(0.75, 0.9, fbmP(p * 55.0 + 3.0, periodN * 55.0, 3)) * 0.0015;
    vec2 tilt = (hash22(b.cell + 2.7) - 0.5) * vec2(0.012, 0.03);
    h = bevel * (0.001 + grain + pits + dot(b.local - vec2(BR_L, BR_C) * 0.5, tilt));
  }
  return h;
}

vec3 buffAlbedo(vec2 p, vec2 period, vec2 periodN, out float rough, out float ao) {
  Brick b = brickAt(p, period);
  float chip = (fbmP(p * 40.0 + b.id * 3.0, periodN * 40.0, 4) - 0.5) * 0.006;
  float jd = b.jd + chip;
  vec3 col = uBitumen;
  rough = 0.75;
  ao = 1.0;
  if (jd < 0.0) {
    float m = fbmP(p * 70.0, periodN * 70.0, 3);
    ao = 0.5 + 0.3 * smoothstep(-0.008, -0.001, jd);
    // bitumen joints, dusted with sand
    col = mix(uBitumen, uBuffA * 0.7, 0.25 + 0.35 * m);
  } else {
    col = mix(uBuffA, uBuffB, smoothstep(0.2, 0.9, b.id));
    col = mix(col, uBuffC, step(0.9, b.id2) * 0.55);
    col *= 0.9 + 0.2 * hash12(b.cell + 1.9);
    float n = fbmP(p * 25.0 + b.id * 4.0, periodN * 25.0, 5);
    col *= 0.86 + 0.28 * n;
    float speck = smoothstep(0.7, 0.75, hash12(floor(p * 900.0)));
    col *= 1.0 - speck * 0.25;
    rough = 0.86 + 0.1 * n;
    ao = 1.0 - (1.0 - smoothstep(0.0, 0.006, jd)) * 0.18;
  }
  return col;
}
`;
