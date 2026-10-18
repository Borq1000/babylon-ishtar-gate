// Smoke: hearth fires rising from the city's roofs, incense from the priests'
// censers in the procession, and braziers at night. Every puff is a camera-
// facing quad whose life cycle (rise, drift with the wind, grow, fade) runs in
// the vertex shader; only moving emitters are updated from the CPU.

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/common.glsl';
import { sharedUniforms } from '../materials/MaterialPatches';
import { windUniforms } from './Palms';
import type { Atmosphere } from './Atmosphere';

const vert = /* glsl */ `
attribute vec4 iEmit;   // xyz emitter position, w emitter scale (0 = off)
attribute vec4 iPuff;   // x phase, y life (s), z rise speed, w seed
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vAge;
void main() {
  vUv = uv;
  float life = iPuff.y;
  float age = fract(uTime / life + iPuff.x);
  float s = iEmit.w;
  vec3 c = iEmit.xyz;
  float rise = iPuff.z * age * life;
  vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * pow(age, 1.5) * life * (0.4 + uWind * 1.4) * s;
  drift += vec3(sin(age * 6.0 + iPuff.w * 9.0), 0.0, cos(age * 5.0 + iPuff.w * 7.0)) * 0.25 * s * age;
  c += vec3(0.0, rise, 0.0) + drift;
  float size = s * (0.3 + 1.5 * age);
  vec3 toCam = normalize(cameraPosition - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  vec3 p = c + (right * position.x + up * position.y) * size;
  vAlpha = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.45, 1.0, age)) * step(0.001, s);
  // small emitters (incense) give thin, faint wisps rather than balls
  vAlpha *= clamp(s * 2.2, 0.3, 1.0);
  vSeed = iPuff.w;
  vAge = age;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const frag = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vAge;
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uOpacity;
${NOISE_GLSL}
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  float n = fbm(vUv * 3.0 + vSeed * 17.0 + vAge * 1.5, 4);
  float a = (1.0 - smoothstep(0.05, 1.0, r + (n - 0.5) * 0.8)) * vAlpha * uOpacity;
  a *= a;
  if (a < 0.004) discard;
  // fake lighting: brighter towards the top of the puff
  vec3 col = mix(uShade, uLit, clamp(0.45 + p.y * 1.2 + (n - 0.5) * 0.5, 0.0, 1.0));
  gl_FragColor = vec4(col, a * 0.32);
}
`;

interface EmitterDef {
  pos: THREE.Vector3;
  scale: number;
  puffs: number;
  life: number;
  rise: number;
  kind: 'hearth' | 'censer' | 'brazier';
}

export class Smoke {
  readonly mesh: THREE.Mesh;
  private emitters: EmitterDef[] = [];
  private emitAttr!: THREE.InstancedBufferAttribute;
  private material: THREE.ShaderMaterial;
  private offsets: number[] = [];

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: sharedUniforms.uTime,
        uWindDir: windUniforms.uWindDir,
        uWind: windUniforms.uWind,
        uLit: { value: new THREE.Color(0.8, 0.7, 0.6) },
        uShade: { value: new THREE.Color(0.3, 0.3, 0.32) },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'smoke';
  }

  add(pos: THREE.Vector3, kind: EmitterDef['kind']): number {
    const def: EmitterDef =
      kind === 'hearth'
        ? { pos: pos.clone(), scale: 3.0 + Math.random() * 2.0, puffs: 16, life: 30, rise: 0.8, kind }
        : kind === 'censer'
          ? { pos: pos.clone(), scale: 0.15, puffs: 10, life: 4, rise: 0.45, kind }
          : { pos: pos.clone(), scale: 0.7, puffs: 10, life: 7, rise: 0.8, kind };
    this.emitters.push(def);
    return this.emitters.length - 1;
  }

  build(): void {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const total = this.emitters.reduce((s, e) => s + e.puffs, 0);
    const emit = new Float32Array(total * 4);
    const puff = new Float32Array(total * 4);
    let k = 0;
    for (const e of this.emitters) {
      this.offsets.push(k);
      for (let i = 0; i < e.puffs; i++, k++) {
        emit.set([e.pos.x, e.pos.y, e.pos.z, e.scale], k * 4);
        puff.set([i / e.puffs + Math.random() * 0.04, e.life * (0.85 + Math.random() * 0.3), e.rise * (0.8 + Math.random() * 0.4), Math.random()], k * 4);
      }
    }
    this.emitAttr = new THREE.InstancedBufferAttribute(emit, 4);
    this.emitAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iEmit', this.emitAttr);
    geo.setAttribute('iPuff', new THREE.InstancedBufferAttribute(puff, 4));
    geo.instanceCount = total;
  }

  /** Moves an emitter (censers follow the priests) and/or switches it on/off. */
  setEmitter(index: number, pos: THREE.Vector3 | null, on: boolean): void {
    const e = this.emitters[index];
    if (!e) return;
    const k0 = this.offsets[index];
    for (let i = 0; i < e.puffs; i++) {
      const k = (k0 + i) * 4;
      if (pos) {
        this.emitAttr.array[k] = pos.x;
        this.emitAttr.array[k + 1] = pos.y;
        this.emitAttr.array[k + 2] = pos.z;
      }
      this.emitAttr.array[k + 3] = on ? e.scale : 0;
    }
    this.emitAttr.needsUpdate = true;
  }

  kindOf(i: number): EmitterDef['kind'] {
    return this.emitters[i].kind;
  }

  get count(): number {
    return this.emitters.length;
  }

  update(atmo: Atmosphere): void {
    const p = atmo.params;
    const u = this.material.uniforms;
    const sun = atmo.keyLightIntensity * (1 - p.night);
    (u.uLit.value as THREE.Color).setRGB(0.62, 0.6, 0.58).lerp(p.sunColor, 0.45).multiplyScalar(0.1 + sun * 0.09);
    (u.uShade.value as THREE.Color).setRGB(0.5, 0.54, 0.62).multiplyScalar(0.06 + 0.55 * p.skyScale * (1 - p.night) + 0.02);
  }
}
