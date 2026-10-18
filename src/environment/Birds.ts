// Flocks of swifts wheeling over the gate and the city at dusk. Flight paths
// and wing beats are computed in the vertex shader from per-bird parameters.

import * as THREE from 'three';
import { sharedUniforms } from '../materials/MaterialPatches';

const vert = /* glsl */ `
attribute float aWing;     // -1 left wing tip, +1 right wing tip, 0 body
attribute vec4 iFlight;    // centre x, z, radius, height
attribute vec4 iParam;     // angular speed, phase, flap freq, scale
uniform float uTime;
uniform float uVisible;
varying float vShade;
void main() {
  float t = uTime * iParam.x + iParam.y;
  // a wandering loop: circle + lobes + vertical undulation
  float r = iFlight.z * (1.0 + 0.25 * sin(t * 2.3 + iParam.y));
  vec3 c = vec3(iFlight.x + cos(t) * r, iFlight.w + sin(t * 1.7 + iParam.y) * 6.0, iFlight.y + sin(t) * r * 0.7);
  vec3 tang = normalize(vec3(-sin(t) * r, cos(t * 1.7 + iParam.y) * 10.2 * iParam.x, cos(t) * r * 0.7));
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), tang));
  vec3 up = cross(tang, side);
  vec3 p = position * iParam.w * uVisible;
  // wing beat: tips swing up and down; gliding pauses
  float glide = smoothstep(0.2, 0.8, sin(uTime * 0.7 + iParam.y * 3.0));
  float flap = sin(uTime * iParam.z + iParam.y * 11.0) * (1.0 - glide * 0.85);
  p.y += abs(aWing) * flap * 0.35 * iParam.w;
  vec3 wp = c + side * p.x + up * p.y + tang * p.z;
  vShade = 0.55 + 0.45 * abs(aWing);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const frag = /* glsl */ `
varying float vShade;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor * vShade, 1.0); }
`;

export class Birds {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(flocks: { x: number; z: number; h: number; r: number; n: number }[]) {
    // a swift: slim body with long swept wings
    const pos = [
      // body
      0, 0, 0.18, 0.03, 0, -0.1, -0.03, 0, -0.1,
      // left wing (x > 0 is the bird's left)
      0.02, 0, 0.06, 0.42, 0.0, -0.16, 0.02, 0, -0.04,
      // right wing
      -0.02, 0, 0.06, -0.02, 0, -0.04, -0.42, 0.0, -0.16,
      // tail
      0, 0, -0.08, 0.05, 0, -0.2, -0.05, 0, -0.2,
    ];
    const wing = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0];
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    base.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('aWing', base.getAttribute('aWing'));
    const flight: number[] = [];
    const param: number[] = [];
    for (const f of flocks) {
      for (let i = 0; i < f.n; i++) {
        flight.push(f.x + (Math.random() - 0.5) * f.r * 0.6, f.z + (Math.random() - 0.5) * f.r * 0.6, f.r * (0.5 + Math.random() * 0.8), f.h + (Math.random() - 0.5) * 14);
        param.push((0.22 + Math.random() * 0.2) * (Math.random() < 0.5 ? -1 : 1), Math.random() * 100, 14 + Math.random() * 6, 0.9 + Math.random() * 0.5);
      }
    }
    geo.setAttribute('iFlight', new THREE.InstancedBufferAttribute(new Float32Array(flight), 4));
    geo.setAttribute('iParam', new THREE.InstancedBufferAttribute(new Float32Array(param), 4));
    geo.instanceCount = flight.length / 4;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime: sharedUniforms.uTime, uVisible: { value: 1 }, uColor: { value: new THREE.Color(0.035, 0.03, 0.03) } },
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'birds';
  }

  update(night: number, skyLight: number): void {
    this.material.uniforms.uVisible.value = 1 - THREE.MathUtils.smoothstep(night, 0.3, 0.8);
    (this.material.uniforms.uColor.value as THREE.Color).setRGB(0.05, 0.045, 0.04).multiplyScalar(0.6 + skyLight);
  }
}
