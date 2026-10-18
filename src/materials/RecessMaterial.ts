// Window slits as real-looking recesses without cutting the wall meshes.
//
// Each slit is a single quad on the wall face. Its fragment shader ray-casts the
// box-shaped cavity behind the quad ("interior mapping"): the hit reveal, sill,
// lintel or dark back wall is then shaded by the standard PBR lighting with the
// hit surface's normal, the sun's shadow map at the opening, an analytic test of
// whether the sun reaches that point past the reveals, and sky visibility that
// falls off with depth.
//
// Geometry attributes: aRecess = (width, height, depth) in metres, color = reveal albedo.

import * as THREE from 'three';
import { sharedUniforms } from './MaterialPatches';

export function makeRecessMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  mat.name = 'recess';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRecessKeyDir = sharedUniforms.uBounceL;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aRecess;
varying vec3 vRecess;
varying vec3 vRWPos;
varying vec3 vRWNrm;
varying vec2 vRUv;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vRecess = aRecess;
        vRWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vRWNrm = normalize(mat3(modelMatrix) * objectNormal);
        vRUv = uv;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRecess;
varying vec3 vRWPos;
varying vec3 vRWNrm;
varying vec2 vRUv;
uniform vec3 uRecessKeyDir;
float gRecSun = 1.0;
float gRecSky = 1.0;
vec3 gRecNormal = vec3(0.0, 0.0, 1.0);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 N = normalize(vRWNrm);
          vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
          vec3 B = cross(N, T);
          vec3 V = normalize(vRWPos - cameraPosition);
          vec3 d = vec3(dot(V, T), dot(V, B), dot(V, N));
          vec2 hs = vRecess.xy * 0.5;
          float dep = vRecess.z;
          vec3 p0 = vec3((vRUv - 0.5) * vRecess.xy, 0.0);
          float tx = abs(d.x) > 1e-5 ? (sign(d.x) * hs.x - p0.x) / d.x : 1e5;
          float ty = abs(d.y) > 1e-5 ? (sign(d.y) * hs.y - p0.y) / d.y : 1e5;
          float tz = d.z < -1e-5 ? (-dep - p0.z) / d.z : 1e5;
          float t = min(tx, min(ty, tz));
          vec3 hp = p0 + d * t;
          bool back = t == tz;
          vec3 hn = back ? vec3(0.0, 0.0, 1.0) : (t == tx ? vec3(-sign(d.x), 0.0, 0.0) : vec3(0.0, -sign(d.y), 0.0));
          float depthK = clamp(-hp.z / max(dep, 1e-3), 0.0, 1.0);
          // can the sun reach the hit point through the opening?
          vec3 Ls = vec3(dot(uRecessKeyDir, T), dot(uRecessKeyDir, B), dot(uRecessKeyDir, N));
          float sun = 0.0;
          if (Ls.z > 1e-3 && dot(hn, Ls) > 0.0) {
            vec2 q = hp.xy + Ls.xy * (-hp.z / Ls.z);
            sun = (1.0 - smoothstep(hs.x - 0.004, hs.x + 0.004, abs(q.x))) * (1.0 - smoothstep(hs.y - 0.004, hs.y + 0.004, abs(q.y)));
          }
          gRecSun = sun;
          // sky visibility: reveals darken with depth, the sill sees more sky, the back almost none
          gRecSky = back ? 0.03 : (hn.y > 0.5 ? mix(0.8, 0.12, depthK) : mix(0.55, 0.05, depthK));
          // a soot-darkened interior beyond the reveals
          diffuseColor.rgb *= back ? 0.18 : mix(1.0, 0.55, depthK);
          gRecNormal = T * hn.x + B * hn.y + N * hn.z;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(gRecNormal, 0.0)).xyz);`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gRecSky;
        reflectedLight.indirectSpecular *= gRecSky * 0.5;`,
      )
      .replace(
        'void main() {',
        `void RE_Direct_Recess(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  IncidentLight dl = directLight;
  dl.color *= gRecSun;
  RE_Direct_Physical(dl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Recess
void main() {`,
      );
  };
  mat.customProgramCacheKey = () => 'recess';
  return mat;
}
