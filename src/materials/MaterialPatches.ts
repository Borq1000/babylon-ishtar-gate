// Shader patches for MeshStandardMaterial (via onBeforeCompile):
//
//  * weathering  – world-space macro colour variation, dust accumulating at the
//                  foot of walls and on upward-facing ledges.
//  * relief      – texture-space ray-marched self-shadowing from a height map
//                  (alpha of the ORM texture) for the key light only. This gives
//                  crisp shadows inside brick joints and under sculpted relief
//                  that a shadow map could never resolve.

import * as THREE from 'three';
import { LAYOUT } from '../world/Layout';

export interface WeatheringOptions {
  macro: THREE.Texture;
  macroScale?: number;
  macroStrength?: number;
  dustColor?: THREE.Color;
  dustHeight?: number;
  dustStrength?: number;
  topDust?: number;
  groundY?: number;
  /**
   * Vertical weathering on walls: rain-wash streaks, construction lifts (bands of
   * slightly different brick batches) and pale salt efflorescence near the foot.
   */
  streaks?: number;
  /** Flat mud roofs: darker patchy earth with reed mats instead of light dust on top faces. */
  roof?: number;
  /** Street paving: wind-blown sand in drifts, along the walls and in the joints. */
  floor?: number;
}

export interface ReliefOptions {
  /** Texture whose alpha channel holds normalized height. */
  heightMap: THREE.Texture;
  /** Metres represented by the 0..1 height range. */
  heightScale: number;
  /** UV units per metre along u and v. */
  uvPerMetre: THREE.Vector2;
  steps: number;
  softness?: number;
}

/**
 * Per-brick tone variation computed in the shader, so that brick colour never
 * repeats with the 2 m texture tile. 'world' derives the brick grid from the
 * world position (walls, bands: their textures follow the world brick grid);
 * 'uv' derives it from the texture (relief panels) and seeds it per instance.
 */
export interface BrickVariationOptions {
  space: 'world' | 'uv';
  /** Relative albedo variation (0.1 ≈ ±10 %). */
  value: number;
  /** Saturation variation (0.2 ≈ ±20 %). */
  saturation?: number;
  /** Roughness variation (absolute ±). */
  roughness?: number;
  /** Panel size in metres (uv space only). */
  panelSize?: THREE.Vector2;
}

export interface PatchOptions {
  weathering?: WeatheringOptions;
  relief?: ReliefOptions;
  bricks?: BrickVariationOptions;
  /** Extra uniforms/injections from other systems (wind etc.). */
  extraKey?: string;
}

/** Shared per-frame uniforms used by all patched materials. */
export const sharedUniforms = {
  uKeyDirView: { value: new THREE.Vector3(0, 1, 0) },
  uTime: { value: 0 },
  uMacroAOStrength: { value: 1 },
  /** Key light colour × intensity, for the analytic street bounce. */
  uBounceE: { value: new THREE.Color(0, 0, 0) },
  /** World direction towards the key light. */
  uBounceL: { value: new THREE.Vector3(0, 1, 0) },
};

/**
 * Large-scale sky-visibility ("macro AO") for the architecture the environment
 * map knows nothing about: the walled street canyon, the long vaulted gate
 * passages and the narrow light-well between the two gates. Indirect light is
 * scaled by it, which restores believable sun/shade contrast.
 */
export function macroAOGlsl(): string {
  const R = LAYOUT.road;
  const P = LAYOUT.procWall;
  const F = LAYOUT.frontGate;
  const M = LAYOUT.rearGate;
  const Ct = LAYOUT.court;
  const f = (n: number) => n.toFixed(3);
  return /* glsl */ `
uniform float uMacroAOStrength;
float tunnelAO(vec3 p, float hw, float zA, float zB, float h) {
  // zA > zB are the open ends of a passage along z
  if (abs(p.x) > hw + 0.6 || p.z > zA + 0.5 || p.z < zB - 0.5 || p.y > h) return 1.0;
  float d = min(zA - p.z, p.z - zB);
  float open = exp(-max(d, 0.0) / 4.0);
  return mix(0.2, 1.0, open);
}
// Fraction of a reflected ray that leaves a passage through one of its open
// ends (an opening of half-width hw up to the crown h); glossy glaze in a
// tunnel mirrors the bright archway, everything else it sees is dark vault.
float tunnelSpecVis(vec3 p, vec3 R, float hw, float zA, float zB, float h, float rough) {
  if (abs(p.x) > hw + 0.6 || p.z > zA + 0.5 || p.z < zB - 0.5 || p.y > h) return 1.0;
  float rz = abs(R.z) < 1e-3 ? 1e-3 : R.z;
  float t = ((rz > 0.0 ? zA : zB) - p.z) / rz;
  vec2 q = p.xy + R.xy * max(t, 0.0);
  float d = max(abs(q.x) - hw, max(q.y - h, -q.y));
  float soft = 0.12 + rough * max(t, 0.0) * 0.7;
  return 1.0 - smoothstep(-soft, soft, d);
}
float canyonAO(vec3 p) {
  float ao = 1.0;
  // Processional Way canyon
  if (abs(p.x) < ${f(R.halfWidth + 0.6)} && p.z > -0.5 && p.z < ${f(R.zEnd)}) {
    float h = ${f(P.height)};
    float up = clamp((p.y + 1.0) / (h + 3.0), 0.0, 1.0);
    float side = 1.0 - smoothstep(${f(R.halfWidth - 6.0)}, ${f(R.halfWidth)}, abs(p.x)) * (1.0 - up) * 0.25;
    ao = min(ao, mix(0.64, 1.0, up) * side);
  }
  // light-well between the gates
  if (abs(p.x) < ${f(F.centreHalfWidth + 0.5)} && p.z < ${f(Ct.z0 + 0.3)} && p.z > ${f(Ct.z1 - 0.3)} && p.y < ${f(Ct.wallHeight)}) {
    ao = min(ao, mix(0.25, 0.9, clamp(p.y / ${f(Ct.wallHeight)}, 0.0, 1.0)));
  }
  return mix(1.0, ao, uMacroAOStrength);
}
float passageAO(vec3 p) {
  float ao = min(
    tunnelAO(p, ${f(F.passageHalfWidth)}, ${f(F.zFront - F.centreRecess)}, ${f(F.zFront - F.depth)}, ${f(F.archSpring + F.passageHalfWidth)}),
    tunnelAO(p, ${f(M.passageHalfWidth)}, ${f(M.zFront - M.centreRecess)}, ${f(M.zFront - M.depth)}, ${f(M.archSpring + M.passageHalfWidth)}));
  return mix(1.0, ao, uMacroAOStrength);
}
float passageSpecVis(vec3 p, vec3 R, float rough) {
  return min(
    tunnelSpecVis(p, R, ${f(F.passageHalfWidth)}, ${f(F.zFront - F.centreRecess)}, ${f(F.zFront - F.depth)}, ${f(F.archSpring + F.passageHalfWidth)}, rough),
    tunnelSpecVis(p, R, ${f(M.passageHalfWidth)}, ${f(M.zFront - M.centreRecess)}, ${f(M.zFront - M.depth)}, ${f(M.archSpring + M.passageHalfWidth)}, rough));
}
float macroAO(vec3 p) {
  return min(canyonAO(p), passageAO(p));
}

// One-bounce sunlight inside the Processional Way. The street is a long canyon,
// so it reduces to 2D: every receiver sees the sunlit strips of the two walls and
// of the pavement, and the differential view factor to a strip in the (x, y)
// cross-section is 0.5·|t·dB − t·dA| (t = receiver tangent, d = unit directions
// to the strip ends). Lit strips follow from the sun direction and wall height.
uniform vec3 uBounceE;   // sun colour × intensity
uniform vec3 uBounceL;   // direction towards the key light (world)
float stripFF(vec2 p, vec2 n, vec2 a, vec2 b) {
  vec2 da = normalize(a - p), db = normalize(b - p);
  float va = dot(n, da), vb = dot(n, db);
  if (va <= 0.0 && vb <= 0.0) return 0.0;
  // clip the strip at the receiver's horizon
  if (va < 0.0) da = normalize(mix(da, db, va / (va - vb)));
  if (vb < 0.0) db = normalize(mix(da, db, va / (va - vb)));
  vec2 t = vec2(n.y, -n.x);
  return 0.5 * abs(dot(t, db) - dot(t, da));
}
vec3 corridorBounce(vec3 p, vec3 n) {
  float hw = ${f(R.halfWidth)};
  if (abs(p.x) > hw + 0.4 || p.z < 0.0 || p.z > ${f(R.zEnd)} || p.y > ${f(P.height + 3.0)}) return vec3(0.0);
  vec2 n2 = n.xy;
  float nl = length(n2);
  if (nl < 0.05) return vec3(0.0);
  n2 /= nl;
  vec2 q = vec2(clamp(p.x, -hw + 0.02, hw - 0.02), max(p.y, 0.02));
  vec3 L = uBounceL;
  float H = ${f(P.height + 0.5)};
  float e = 0.0;
  if (abs(L.x) > 0.01 && L.y > 0.01) {
    float sx = sign(L.x);                 // the sunlit wall stands on the -sx side
    float hs = clamp(H - 2.0 * hw * L.y / abs(L.x), 0.0, H);
    float wallLit = abs(L.x);             // n·L of that wall
    e += 0.4 * wallLit * stripFF(q, n2, vec2(-sx * hw, hs), vec2(-sx * hw, H));
    float reach = H * abs(L.x) / L.y;     // shadow of the other wall on the pavement
    float x0 = -sx * hw, x1 = sx * (hw - reach);
    if (sx * (x1 - x0) > 0.0) e += 0.38 * L.y * stripFF(q, n2, vec2(x0, 0.0), vec2(x1, 0.0));
  } else if (L.y > 0.01) {
    e += 0.38 * L.y * stripFF(q, n2, vec2(-hw, 0.0), vec2(hw, 0.0));
  }
  return uBounceE * e * nl;
}
`;
}

let patchCounter = 0;

export function patchMaterial(mat: THREE.MeshStandardMaterial, opts: PatchOptions): THREE.MeshStandardMaterial {
  const w = opts.weathering;
  const r = opts.relief;
  const bv = opts.bricks;
  const id = ++patchCounter;
  const uniforms: Record<string, THREE.IUniform> = {
    uKeyDirView: sharedUniforms.uKeyDirView,
    uMacroAOStrength: sharedUniforms.uMacroAOStrength,
    uBounceE: sharedUniforms.uBounceE,
    uBounceL: sharedUniforms.uBounceL,
  };
  if (w) {
    uniforms.uMacro = { value: w.macro };
    uniforms.uMacroScale = { value: w.macroScale ?? 0.02 };
    uniforms.uMacroStrength = { value: w.macroStrength ?? 0.5 };
    uniforms.uDustColor = { value: w.dustColor ?? new THREE.Color().setHex(0xb59d7a, THREE.SRGBColorSpace) };
    uniforms.uDustHeight = { value: w.dustHeight ?? 0.9 };
    uniforms.uDustStrength = { value: w.dustStrength ?? 0.55 };
    uniforms.uTopDust = { value: w.topDust ?? 0.5 };
    uniforms.uGroundY = { value: w.groundY ?? 0 };
    uniforms.uStreaks = { value: w.streaks ?? 0 };
    uniforms.uRoof = { value: w.roof ?? 0 };
    uniforms.uFloor = { value: w.floor ?? 0 };
  }
  if (bv) {
    uniforms.uBrickVar = { value: new THREE.Vector3(bv.value, bv.saturation ?? 0, bv.roughness ?? 0) };
    uniforms.uBrickPanel = { value: (bv.panelSize ?? new THREE.Vector2(1, 1)).clone() };
  }
  if (r) {
    uniforms.uReliefMap = { value: r.heightMap };
    uniforms.uReliefScale = { value: r.heightScale };
    uniforms.uReliefUVPerM = { value: r.uvPerMetre.clone() };
    uniforms.uReliefSoft = { value: r.softness ?? 7.0 };
    uniforms.uReliefTexSize = {
      value: new THREE.Vector2(
        (r.heightMap.image as { width?: number })?.width ?? 2048,
        (r.heightMap.image as { height?: number })?.height ?? 2048,
      ),
    };
  }

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    // ---------- vertex: world position varying ----------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec2 vPatchSeed;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 wpp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wpp = instanceMatrix * wpp;
            vPatchSeed = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz;
          #else
            vPatchSeed = modelMatrix[3].xz;
          #endif
          vWPos = (modelMatrix * wpp).xyz;
        }`,
      );

    // ---------- fragment ----------
    let pars = '\nvarying vec3 vWPos;\nvarying vec2 vPatchSeed;\nuniform vec3 uKeyDirView;\n' + macroAOGlsl();
    if (bv) {
      pars += `uniform vec3 uBrickVar; uniform vec2 uBrickPanel;
float gBrickRough = 0.0;
float pbHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pbNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pbHash(i), pbHash(i + vec2(1.0, 0.0)), u.x), mix(pbHash(i + vec2(0.0, 1.0)), pbHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;
    }
    if (w) {
      pars += `uniform sampler2D uMacro; uniform float uMacroScale; uniform float uMacroStrength;
uniform vec3 uDustColor; uniform float uDustHeight; uniform float uDustStrength; uniform float uTopDust; uniform float uGroundY; uniform float uStreaks; uniform float uRoof; uniform float uFloor;
float gDust = 0.0;
`;
    }
    if (r) {
      pars += `uniform sampler2D uReliefMap; uniform float uReliefScale; uniform vec2 uReliefUVPerM; uniform float uReliefSoft; uniform vec2 uReliefTexSize;
mat3 gTBN; vec2 gReliefUv; float gReliefLod; float gReliefOn = 0.0;
`;
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>' + pars);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
      {
        float cao = canyonAO(vWPos);
        float pao = passageAO(vWPos);
        reflectedLight.indirectDiffuse *= min(cao, pao);
        vec3 wNrm = normalize(transpose(mat3(viewMatrix)) * normal);
        vec3 wR = reflect(normalize(vWPos - cameraPosition), wNrm);
        float sVis = passageSpecVis(vWPos, wR, material.roughness);
        reflectedLight.indirectSpecular *= mix(1.0, cao, 0.8) * mix(pao * 0.5, 1.0, sVis);
        vec3 bnc = corridorBounce(vWPos, wNrm);
        #ifdef USE_AOMAP
          bnc *= ambientOcclusion;
        #endif
        reflectedLight.indirectDiffuse += bnc * BRDF_Lambert(material.diffuseColor);
      }`,
    );

    if (w) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec4 mac = texture2D(uMacro, vWPos.xz * uMacroScale + vWPos.y * 0.004);
          vec4 mac2 = texture2D(uMacro, vec2(vWPos.x + vWPos.z, vWPos.y) * uMacroScale * 6.0);
          diffuseColor.rgb *= mix(1.0, 0.78 + 0.44 * mac.r, uMacroStrength);
          diffuseColor.rgb *= mix(1.0, 0.9 + 0.2 * mac2.g, uMacroStrength);
          float hgt = max(vWPos.y - uGroundY, 0.0);
          float baseDust = exp(-hgt / uDustHeight) * uDustStrength * (0.55 + 0.9 * mac2.r);
          vec3 wN = transpose(mat3(viewMatrix)) * normalize(vNormal);
          if (uStreaks > 0.0 && abs(wN.y) < 0.5) {
            float su = abs(wN.x) >= abs(wN.z) ? vWPos.z : vWPos.x;
            // long vertical streaks: fast along the wall, very slow with height
            float sa = texture2D(uMacro, vec2(su * 0.0625, vWPos.y * 0.0025)).a;
            float sb = texture2D(uMacro, vec2(su * 0.021 + 0.37, vWPos.y * 0.006)).r;
            float streak = smoothstep(0.5, 0.74, sa) * smoothstep(0.3, 0.7, sb);
            diffuseColor.rgb *= 1.0 - uStreaks * streak;
            // construction lifts: courses laid in campaigns of ~1.5 m
            float lift = fract(sin(floor(vWPos.y / 1.5 + 0.3 * mac.r) * 91.7 + floor(su / 23.0) * 13.1) * 43758.5);
            diffuseColor.rgb *= 1.0 + uStreaks * 0.45 * (lift - 0.5);
            // pale salt efflorescence in patches above the dusty foot
            float salt = smoothstep(0.55, 0.85, mac2.b) * (1.0 - smoothstep(0.4, 2.2, hgt));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.6, 0.55), salt * uStreaks * 1.6);
          }
          float top = smoothstep(0.55, 0.95, wN.y) * uTopDust * (0.6 + 0.6 * mac.g);
          if (uRoof > 0.0 && wN.y > 0.7 && vWPos.y > 1.5) {
            // packed-mud roof: darker earth, trampled patches, a few reed mats
            vec4 rm = texture2D(uMacro, vWPos.xz * 0.045);
            vec3 roofCol = vec3(0.3, 0.245, 0.18) * (0.78 + 0.44 * rm.a) * (0.9 + 0.2 * rm.r);
            vec2 rc = floor(vWPos.xz / 2.3);
            float rsel = fract(sin(dot(rc, vec2(12.9898, 78.233))) * 43758.5453);
            vec2 rf = fract(vWPos.xz / 2.3);
            float reed = step(0.8, rsel) * step(0.1, rf.x) * step(rf.x, 0.9) * step(0.18, rf.y) * step(rf.y, 0.82);
            roofCol = mix(roofCol, vec3(0.5, 0.42, 0.26) * (0.85 + 0.15 * sin(vWPos.x * 40.0)), reed * 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, roofCol, uRoof * smoothstep(0.7, 0.9, wN.y));
            top *= 1.0 - uRoof * 0.8;
          }
          if (uFloor > 0.0 && wN.y > 0.7) {
            // sand drifts: patchy at large scale, collecting along the street walls
            // and gate jambs, and settling into the joints (dark, low AO texels)
            vec4 d1 = texture2D(uMacro, vWPos.xz * 0.021 + 0.13);
            vec4 d2 = texture2D(uMacro, vWPos.xz * 0.11 + 0.71);
            float drift = smoothstep(0.42, 0.78, d1.r * 0.75 + d2.g * 0.45);
            float wall = smoothstep(${(LAYOUT.road.halfWidth - 3.5).toFixed(2)}, ${(LAYOUT.road.halfWidth - 0.1).toFixed(2)}, abs(vWPos.x)) * step(-0.5, vWPos.z);
            float joint = 1.0 - smoothstep(0.08, 0.3, dot(diffuseColor.rgb, vec3(0.333)));
            top = max(top, uFloor * clamp(drift * 0.55 + wall * 0.7 + joint * 0.5 * (0.4 + drift), 0.0, 1.0));
          }
          gDust = clamp(baseDust + top, 0.0, 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, uDustColor * (0.85 + 0.3 * mac.a), gDust);
        }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.97, gDust);`,
      );
    }

    if (bv) {
      const cell =
        bv.space === 'world'
          ? `vec3 bN = transpose(mat3(viewMatrix)) * normalize(vNormal);
          bool bOn = abs(bN.y) < 0.6;
          bool xFace = abs(bN.x) >= abs(bN.z);
          float bu = xFace ? (bN.x > 0.0 ? -vWPos.z : vWPos.z) : (bN.z > 0.0 ? vWPos.x : -vWPos.x);
          float brow = floor((vWPos.y + 1e-4) / 0.083333333);
          float bcol = floor((bu + mod(brow, 2.0) * 0.16666667) / 0.33333333);
          vec2 bc = vec2(bcol, brow) + (xFace ? vec2(0.0) : vec2(0.0, 977.0)) + ((bN.x + bN.z) > 0.0 ? vec2(613.0, 0.0) : vec2(0.0));`
          : `bool bOn = true;
          vec2 bm = vMapUv * uBrickPanel;
          float brow = floor(bm.y / 0.083333333);
          float bcol = floor((bm.x + mod(brow, 2.0) * 0.16666667) / 0.33333333);
          vec2 bc = vec2(bcol, brow) + floor(vPatchSeed * 3.0) * vec2(0.37, 0.61);`;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          ${cell}
          if (bOn) {
            float bh = pbHash(bc + 0.5);
            float bh2 = pbHash(bc + 71.3);
            float bb = pbNoise(bc / vec2(4.0, 7.0));
            diffuseColor.rgb *= max(0.0, 1.0 + uBrickVar.x * ((bh - 0.5) * 1.3 + (bb - 0.5) * 1.0));
            float bl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = max(vec3(0.0), mix(vec3(bl), diffuseColor.rgb, 1.0 + uBrickVar.y * (bh2 - 0.5) * 2.0));
            gBrickRough = uBrickVar.z * (bh2 - 0.5) * 2.0;
          }
        }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + gBrickRough, 0.04, 1.0);`,
      );
    }

    if (r) {
      const steps = Math.max(1, r.steps | 0);
      const funcs = /* glsl */ `
float reliefShadow(vec3 L) {
  if (gReliefOn < 0.5) return 1.0;
  if (dot(L, uKeyDirView) < 0.9995) return 1.0; // key light only
  vec3 T = normalize(gTBN[0]); vec3 B = normalize(gTBN[1]); vec3 N = normalize(gTBN[2]);
  vec3 Lt = vec3(dot(L, T), dot(L, B), dot(L, N));
  if (Lt.z <= 0.03) return 1.0;
  float h0 = textureLod(uReliefMap, gReliefUv, gReliefLod).a;
  vec2 dUV = Lt.xy / Lt.z * uReliefScale * uReliefUVPerM;
  float sh = 1.0;
  for (int i = 1; i <= ${steps}; i++) {
    float t = (float(i) / ${steps}.0) * (1.0 - h0);
    float h = textureLod(uReliefMap, gReliefUv + dUV * t, gReliefLod).a;
    float rayH = h0 + t;
    sh = min(sh, clamp(1.0 - (h - rayH) * uReliefSoft / (t * 4.0 + 0.04), 0.0, 1.0));
  }
  return sh;
}
void RE_Direct_Relief(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  IncidentLight dl = directLight;
  dl.color *= reliefShadow(dl.direction);
  RE_Direct_Physical(dl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Relief
`;
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', funcs + '\nvoid main() {');
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #if defined( USE_NORMALMAP_TANGENTSPACE )
          gTBN = tbn;
          gReliefUv = vNormalMapUv;
          vec2 rdx = dFdx(gReliefUv * uReliefTexSize), rdy = dFdy(gReliefUv * uReliefTexSize);
          gReliefLod = max(0.0, 0.5 * log2(max(dot(rdx, rdx), dot(rdy, rdy))) - 0.5);
          gReliefOn = 1.0;
        #endif`,
      );
    }
  };
  // Identical patch options produce identical GLSL, so programs can be shared.
  void id;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}|patch|${w ? 'w' : ''}${r ? 'r' + r.steps : ''}${bv ? 'b' + bv.space : ''}|${opts.extraKey ?? ''}`;
  mat.needsUpdate = true;
  return mat;
}
