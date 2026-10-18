// Fine dust motes drifting around the viewer. Each mote samples the volume
// shadow map, so it only glints where sunlight actually reaches — and glows
// most when looking towards the sun (forward scattering).

import * as THREE from 'three';
import type { VolumeShadow } from '../rendering/VolumeShadow';
import type { Atmosphere } from './Atmosphere';
import { sharedUniforms } from '../materials/MaterialPatches';
import { windUniforms } from './Palms';

const vert = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform sampler2D uVolShadowMap;
uniform mat4 uVolShadowMatrix;
uniform float uVolShadowEnabled;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uDust;
uniform float uPixelScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float sp = 0.35 + aSeed.w;
  vec3 drift = vec3(uWindDir.x, 0.02, uWindDir.y) * uTime * (0.25 + uWind * 0.9) * sp;
  drift += vec3(sin(uTime * 0.31 + aSeed.w * 31.0), sin(uTime * 0.23 + aSeed.x * 17.0) * 0.4, cos(uTime * 0.27 + aSeed.z * 23.0)) * 0.7;
  vec3 local = fract(aSeed.xyz + (drift - uCam * vec3(1.0, 0.0, 1.0)) / uBox);
  vec3 wp = vec3(uCam.x, 0.0, uCam.z) + vec3(local.x - 0.5, local.y, local.z - 0.5) * uBox;
  float lit = 1.0;
  if (uVolShadowEnabled > 0.5) {
    vec4 s = uVolShadowMatrix * vec4(wp, 1.0);
    if (s.x > 0.0 && s.x < 1.0 && s.y > 0.0 && s.y < 1.0) lit = step(s.z - 0.002, texture2D(uVolShadowMap, s.xy).r);
  }
  vec3 V = normalize(wp - cameraPosition);
  float fwd = 0.18 + pow(max(dot(V, uSunDir), 0.0), 5.0) * 2.6 + pow(max(dot(V, uSunDir), 0.0), 40.0) * 4.0;
  float dist = length(wp - cameraPosition);
  float fade = smoothstep(0.5, 2.0, dist) * (1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.48, dist));
  float heightFade = 1.0 - smoothstep(3.0, uBox.y, wp.y);
  vAlpha = lit * fade * heightFade * uDust * (0.35 + 0.65 * fract(aSeed.w * 7.31));
  vColor = uSunColor * fwd;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  gl_PointSize = clamp((0.006 + 0.014 * aSeed.w) * uPixelScale / max(dist, 0.1), 1.0, 5.0);
}
`;

const frag = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.15, 0.5, d)) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

export class Dust {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private total: number;

  constructor(count: number, volume: VolumeShadow) {
    this.total = count;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(64, 14, 64) },
        uTime: sharedUniforms.uTime,
        uWindDir: windUniforms.uWindDir,
        uWind: windUniforms.uWind,
        uVolShadowMap: volume.uniforms.uVolShadowMap,
        uVolShadowMatrix: volume.uniforms.uVolShadowMatrix,
        uVolShadowEnabled: volume.uniforms.uVolShadowEnabled,
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
        uDust: { value: 1 },
        uPixelScale: { value: 800 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.name = 'dust';
  }

  setFraction(f: number): void {
    this.points.geometry.setDrawRange(0, Math.floor(this.total * f));
  }

  update(camera: THREE.PerspectiveCamera, atmo: Atmosphere, drawHeight: number): void {
    const u = this.material.uniforms;
    (u.uCam.value as THREE.Vector3).copy(camera.position);
    (u.uSunDir.value as THREE.Vector3).copy(atmo.keyLightDir);
    (u.uSunColor.value as THREE.Color).copy(atmo.keyLightColor).multiplyScalar(atmo.keyLightIntensity * 0.055);
    u.uDust.value = atmo.params.dust;
    u.uPixelScale.value = drawHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }
}
