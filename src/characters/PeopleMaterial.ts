// Instanced GPU-skinned material for the MakeHuman crowd.
//
// Vertex: every instance carries two clip cursors (iAnimA / iAnimB: first row,
// frame count, phase 0..1, blend) into the shared bone-matrix texture; bone
// matrices are fetched with texelFetch, interpolated between frames and
// blended between the two clips, then the standard 4-influence skinning runs.
//
// Fragment: per-part shading — atlas-textured skin, eyes and alpha-tested
// hair / beards / brows / lashes; procedural woven garments coloured per
// instance (hem border, fringed shawl band); bronze for helmets.

import * as THREE from 'three';
import { patchMaterial } from '../materials/MaterialPatches';
import { PART } from './People';

const SKIN_PARS = /* glsl */ `
uniform highp sampler2D uBoneTex;
uniform highp sampler2D uAgentTex; // 3 texels per person: garment+skin tone, accent+hair tone, headwear+seed
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec2 aPart;  // part id, garment hem height
attribute vec4 iAnimA; // row, frames, phase, blend(B)
attribute vec4 iAnimB; // row, frames, phase, smooth + 2 * person id
varying float vPart;
varying float vHem;
varying vec4 vColA;
varying vec4 vColB;
varying vec4 vColC;
varying vec2 vPUv;
mat4 pplBone(float row, float bone) {
  int x = int(bone) * 4;
  int y = int(row);
  return mat4(texelFetch(uBoneTex, ivec2(x, y), 0), texelFetch(uBoneTex, ivec2(x + 1, y), 0),
              texelFetch(uBoneTex, ivec2(x + 2, y), 0), texelFetch(uBoneTex, ivec2(x + 3, y), 0));
}
// iAnimB.w > 0.5: interpolate between frames (near people); far people snap to frames
mat4 pplClipBone(vec4 a, float bone, bool smoothF) {
  float f = fract(a.z) * a.y;
  float f0 = floor(f);
  if (!smoothF) return pplBone(a.x + f0, bone);
  float t = f - f0;
  float f1 = mod(f0 + 1.0, a.y);
  return pplBone(a.x + f0, bone) * (1.0 - t) + pplBone(a.x + f1, bone) * t;
}
mat4 pplSkinMatrix() {
  mat4 m = mat4(0.0);
  float blend = iAnimA.w;
  bool smoothF = mod(iAnimB.w, 2.0) > 0.5;
  for (int k = 0; k < 4; k++) {
    float w = skinWeight[k];
    if (w <= 0.0) continue;
    mat4 b;
    // only fetch the clip(s) actually contributing
    if (blend < 0.002) b = pplClipBone(iAnimA, skinIndex[k], smoothF);
    else if (blend > 0.998) b = pplClipBone(iAnimB, skinIndex[k], smoothF);
    else b = pplClipBone(iAnimA, skinIndex[k], smoothF) * (1.0 - blend) + pplClipBone(iAnimB, skinIndex[k], smoothF) * blend;
    m += b * w;
  }
  return m;
}
`;

const FRAG_PARS = /* glsl */ `
varying float vPart;
varying float vHem;
varying vec4 vColA;
varying vec4 vColB;
varying vec4 vColC;
varying vec2 vPUv;
uniform sampler2D uAtlas;
float pplHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pplNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pplHash(i), pplHash(i + vec2(1.0, 0.0)), u.x), mix(pplHash(i + vec2(0.0, 1.0)), pplHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float gPplRough = 0.8;
float gPplMetal = 0.0;
`;

/** Garment shading in (theta/2pi, height above hem) space. */
const CLOTH_GLSL = /* glsl */ `
{
  int part = int(vPart + 0.5);
  vec2 g = vPUv;
  float circ = 1.9; // ~metres around the body
  vec2 wp = vec2(g.x * circ, g.y);
  // woven wool: ribs fade out before they alias (screen-space footprint), slubs
  // along the warp and a large-scale uneven dyeing
  float fw = max(fwidth(wp.x), fwidth(wp.y)) * 160.0;
  float ribK = 1.0 - smoothstep(0.25, 0.7, fw);
  float warp = 0.5 + 0.5 * sin(wp.x * 1000.0);
  float weft = 0.5 + 0.5 * sin(wp.y * 1000.0);
  float slub = pplNoise(wp * vec2(9.0, 70.0));
  float weave = 0.93 + 0.07 * ribK * (warp * weft - 0.25) + 0.1 * (slub - 0.5) + 0.06 * (pplNoise(wp * vec2(3.0, 12.0)) - 0.5);
  float fade = 0.88 + 0.24 * pplNoise(wp * 1.7 + vColC.w * 13.0);
  vec3 base = (part == 7 ? vColC.rgb : vColA.rgb) * weave * fade;
  if (part == 6) {
    // hem: a woven border in the accent colour with a dark line and a fringe
    float border = smoothstep(0.075, 0.07, g.y) * step(0.012, g.y);
    float line = smoothstep(0.08, 0.077, g.y) - smoothstep(0.077, 0.074, g.y);
    base = mix(base, vColB.rgb * (0.85 + 0.15 * warp), border);
    base *= 1.0 - 0.45 * line;
    float threads = mix(0.55, step(0.45, fract(wp.x * 140.0 + pplHash(vec2(floor(wp.x * 140.0), 3.0)) * 0.3)), ribK);
    base = mix(base, vColB.rgb * 0.75, step(g.y, 0.012) * threads);
    // shawl: a fringed band wrapped from the left shoulder to the right hip
    float phi = fract(g.x - 0.25 + 0.5) - 0.5;  // 0 at the left side, +-0.5 at the right
    float t = abs(phi) / 0.5;
    float hTop = uPplShoulder - 0.06;
    float hc = mix(hTop, uPplHip, t);
    float d = (g.y + vHem) - hc;
    float band = smoothstep(0.1, 0.085, abs(d));
    float fringe = (smoothstep(-0.135, -0.125, d) - smoothstep(-0.1, -0.085, d)) * mix(0.5, step(0.5, fract(wp.x * 160.0)), ribK);
    vec3 shawl = vColB.rgb * (0.9 + 0.1 * ribK * (weft - 0.5)) * (0.9 + 0.14 * pplNoise(wp * vec2(30.0, 3.0)));
    float edge = smoothstep(0.1, 0.092, abs(d)) - smoothstep(0.092, 0.084, abs(d));
    shawl *= 1.0 - 0.35 * edge;
    float onTorso = step(0.25, g.y) * step(uPplHip - 0.25, g.y + vHem);
    base = mix(base, shawl, band * onTorso);
    base = mix(base, vColB.rgb * 0.7, fringe * onTorso);
  }
  diffuseColor.rgb = base;
  gPplRough = 0.86;
}
`;

export interface PeopleUniforms {
  uBoneTex: THREE.IUniform<THREE.Texture>;
  uAtlas: THREE.IUniform<THREE.Texture>;
}

function injectVertex(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + SKIN_PARS)
    .replace(
      '#include <skinbase_vertex>',
      `mat4 pplM = pplSkinMatrix();
       {
         int pid = int(floor(iAnimB.w * 0.5 + 0.01)) * 3;
         vColA = texelFetch(uAgentTex, ivec2(pid, 0), 0);
         vColB = texelFetch(uAgentTex, ivec2(pid + 1, 0), 0);
         vColC = texelFetch(uAgentTex, ivec2(pid + 2, 0), 0);
       }
       vPart = aPart.x; vHem = aPart.y; vPUv = uv;`,
    )
    .replace('#include <skinnormal_vertex>', 'objectNormal = normalize(mat3(pplM) * objectNormal);')
    .replace('#include <skinning_vertex>', 'transformed = (pplM * vec4(transformed, 1.0)).xyz;');
  // beginnormal must exist before skinbase (it does in meshphysical); in the depth shader there is no normal path
  if (!shader.vertexShader.includes('pplSkinMatrix()')) {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nmat4 pplM = pplSkinMatrix();`);
  }
}

export function makePeopleMaterial(lib: { boneTexture: THREE.Texture; atlas: THREE.Texture }, agentTex: THREE.Texture, shoulderZ: number, hipZ: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'people';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBoneTex = { value: lib.boneTexture };
    shader.uniforms.uAgentTex = { value: agentTex };
    shader.uniforms.uAtlas = { value: lib.atlas };
    shader.uniforms.uPplShoulder = { value: shoulderZ };
    shader.uniforms.uPplHip = { value: hipZ };
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS + '\nuniform float uPplShoulder;\nuniform float uPplHip;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          int part = int(vPart + 0.5);
          if (part == ${PART.cloth} || part == ${PART.cloth2} || part == ${PART.sleeve}) {
            ${CLOTH_GLSL}
          } else if (part == ${PART.metal}) {
            diffuseColor.rgb = vec3(0.62, 0.43, 0.24) * (0.85 + 0.3 * pplNoise(vPUv * 40.0));
            gPplRough = 0.38; gPplMetal = 1.0;
          } else if (part == ${PART.gold}) {
            diffuseColor.rgb = vec3(0.95, 0.68, 0.3);
            gPplRough = 0.28; gPplMetal = 1.0;
          } else if (part == ${PART.wood}) {
            float gr = pplNoise(vPUv * vec2(6.0, 90.0));
            diffuseColor.rgb = vec3(0.32, 0.2, 0.11) * (0.75 + 0.5 * gr);
            gPplRough = 0.7;
          } else if (part == ${PART.leather}) {
            diffuseColor.rgb = vec3(0.3, 0.17, 0.09);
            gPplRough = 0.65;
          } else if (part == ${PART.reed}) {
            float wv = 0.5 + 0.5 * sin(vPUv.x * 140.0) * sin(vPUv.y * 140.0);
            diffuseColor.rgb = vec3(0.62, 0.48, 0.27) * (0.75 + 0.35 * wv);
            gPplRough = 0.85;
          } else if (part == ${PART.clay}) {
            diffuseColor.rgb = vec3(0.62, 0.36, 0.22) * (0.88 + 0.2 * pplNoise(vPUv * 12.0));
            gPplRough = 0.8;
          } else {
            vec4 tx = texture2D(uAtlas, vPUv);
            if (part == ${PART.skin}) {
              // Mediterranean / Near-Eastern complexion: warm and slightly olive
              vec3 tone = mix(vec3(0.94, 0.8, 0.68), vec3(0.7, 0.54, 0.42), vColA.w);
              float l = dot(tx.rgb, vec3(0.299, 0.587, 0.114));
              diffuseColor.rgb = mix(vec3(l), tx.rgb, 0.75) * tone * 1.08;
              gPplRough = 0.58;
            } else if (part == ${PART.eyes}) {
              diffuseColor.rgb = tx.rgb;
              gPplRough = 0.2;
            } else {
              // beards and brows are sparse cards: a lower cut keeps them full
              if (tx.a < (part == ${PART.beard} || part == ${PART.brows} ? 0.2 : 0.42)) discard;
              // hair, beards, brows, lashes: very dark brown to black, greying with age
              vec3 hairCol = mix(vec3(0.035, 0.026, 0.02), vec3(0.11, 0.075, 0.05), vColB.w);
              // elders (seed > 1.5): iron-grey to white hair and beards
              if (vColC.w > 1.5) hairCol = mix(vec3(0.3, 0.29, 0.27), vec3(0.62, 0.6, 0.56), fract(vColC.w));
              float lum = dot(tx.rgb, vec3(0.333));
              diffuseColor.rgb = hairCol * (0.7 + 0.9 * lum);
              gPplRough = 0.62;
            }
          }
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = gPplRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = gPplMetal;');
  };
  mat.customProgramCacheKey = () => 'people';
  patchMaterial(mat, { extraKey: 'people' });
  return mat;
}

export function makePeopleDepthMaterial(lib: { boneTexture: THREE.Texture; atlas: THREE.Texture }): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBoneTex = { value: lib.boneTexture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_PARS)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         { mat4 pplM = pplSkinMatrix(); transformed = (pplM * vec4(transformed, 1.0)).xyz; }`,
      );
  };
  mat.customProgramCacheKey = () => 'peopleDepth';
  return mat;
}

/** Main-pass material of the shadow proxies: collapses every vertex outside the clip volume. */
export function makeShadowProxyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'peopleShadowProxy',
    vertexShader: 'void main() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    colorWrite: false,
    depthWrite: false,
  });
}
