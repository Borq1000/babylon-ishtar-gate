// Oil-lamp torches and bronze braziers for the night. All flames are one
// instanced billboard draw call with a procedural flame shader; only a handful
// of real point lights exist and they are re-assigned to the flames nearest to
// the viewer, so the city stays sparsely, believably lit.

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/common.glsl';
import { sharedUniforms } from '../materials/MaterialPatches';
import type { MaterialLibrary } from '../materials/MaterialLibrary';

export interface LampSpot {
  pos: THREE.Vector3;
  kind: 'torch' | 'brazier';
}

const flameVert = /* glsl */ `
attribute vec4 iFlame; // xyz position, w scale
varying vec2 vUv;
varying float vSeed;
uniform float uLamps;
void main() {
  vUv = uv;
  vSeed = iFlame.x * 0.37 + iFlame.z * 0.11;
  vec3 c = iFlame.xyz;
  float s = iFlame.w * uLamps;
  // cylindrical billboard: face the camera around the vertical axis
  vec3 toCam = normalize(vec3(cameraPosition.x - c.x, 0.0, cameraPosition.z - c.z));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 p = c + right * position.x * s * 0.55 + vec3(0.0, 1.0, 0.0) * (position.y + 0.5) * s * 1.25;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const flameFrag = /* glsl */ `
varying vec2 vUv;
varying float vSeed;
uniform float uTime;
uniform float uLamps;
${NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  p.y = vUv.y;
  float t = uTime * 2.4 + vSeed * 13.0;
  float n = fbm(vec2(p.x * 3.0 + vSeed, vUv.y * 3.5 - t), 4);
  float n2 = vnoise(vec2(p.x * 7.0, vUv.y * 6.0 - t * 1.7));
  float width = (1.0 - vUv.y) * 0.75 * (0.85 + 0.3 * n);
  float shape = 1.0 - smoothstep(width * 0.55, width, abs(p.x + (n - 0.5) * 0.35 * vUv.y));
  shape *= smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.55 + 0.35 * n2, 1.0, vUv.y));
  float core = shape * (1.0 - smoothstep(0.0, 0.5, vUv.y)) * (1.0 - smoothstep(0.0, width * 0.5 + 0.02, abs(p.x)));
  vec3 col = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.62, 0.22), shape);
  col = mix(col, vec3(1.0, 0.92, 0.7), core);
  float a = shape * uLamps;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * a * 9.0, a);
}
`;

export class NightLights {
  readonly group = new THREE.Group();
  private flames: THREE.Mesh;
  private lights: THREE.PointLight[] = [];
  private uniforms = { uLamps: { value: 0 }, uTime: sharedUniforms.uTime };
  private timer = 0;
  private flicker: number[] = [];
  private assigned: (LampSpot | null)[] = [];
  level = 0;

  constructor(
    private spots: LampSpot[],
    mats: MaterialLibrary,
    maxLights: number,
  ) {
    this.group.name = 'nightLights';
    // flames
    const quad = new THREE.PlaneGeometry(1, 1);
    const inst = new Float32Array(spots.length * 4);
    spots.forEach((s, i) => {
      const scale = s.kind === 'brazier' ? 0.9 : 0.42;
      const y = s.kind === 'brazier' ? s.pos.y + 0.32 : s.pos.y + 0.3;
      inst.set([s.pos.x, y, s.pos.z, scale], i * 4);
    });
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = spots.length;
    geo.setAttribute('iFlame', new THREE.InstancedBufferAttribute(inst, 4));
    const mat = new THREE.ShaderMaterial({
      vertexShader: flameVert,
      fragmentShader: flameFrag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.flames = new THREE.Mesh(geo, mat);
    this.flames.frustumCulled = false;
    this.flames.renderOrder = 5;
    this.group.add(this.flames);

    // holders: torch brackets and bronze braziers on tripods
    const wood = mats.wood;
    const bronze = mats.bronze;
    const torchGeo = new THREE.CylinderGeometry(0.035, 0.03, 0.55, 6).translate(0, 0.0, 0);
    const bowlGeo = new THREE.SphereGeometry(0.32, 14, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5).translate(0, 0.3, 0);
    const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.9, 5);
    for (const s of spots) {
      if (s.kind === 'torch') {
        const t = new THREE.Mesh(torchGeo, wood);
        t.position.copy(s.pos);
        this.group.add(t);
      } else {
        const b = new THREE.Mesh(bowlGeo, bronze);
        b.position.copy(s.pos);
        b.castShadow = true;
        this.group.add(b);
        for (let k = 0; k < 3; k++) {
          const l = new THREE.Mesh(legGeo, bronze);
          const a = (k / 3) * Math.PI * 2;
          l.position.set(s.pos.x + Math.cos(a) * 0.2, s.pos.y - 0.15, s.pos.z + Math.sin(a) * 0.2);
          l.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
          if (s.pos.y < 0.5) this.group.add(l);
        }
      }
    }
    // a pool of point lights (no shadows), reassigned to the nearest flames
    for (let i = 0; i < maxLights; i++) {
      const l = new THREE.PointLight(0xff9a4a, 0, 22, 1.6);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
      this.flicker.push(Math.random() * 10);
      this.assigned.push(null);
    }
  }

  update(dt: number, time: number, level: number, viewer: THREE.Vector3): void {
    this.level = level;
    this.uniforms.uLamps.value = level;
    this.flames.visible = level > 0.01;
    this.timer -= dt;
    if (this.timer <= 0 && level > 0.01) {
      this.timer = 0.5;
      const sorted = [...this.spots].sort((a, b) => a.pos.distanceToSquared(viewer) - b.pos.distanceToSquared(viewer));
      for (let i = 0; i < this.lights.length; i++) this.assigned[i] = sorted[i] ?? null;
    }
    this.lights.forEach((l, i) => {
      const s = this.assigned[i];
      if (!s || level < 0.01) {
        l.intensity = 0;
        return;
      }
      l.position.set(s.pos.x, s.pos.y + (s.kind === 'brazier' ? 0.9 : 0.55), s.pos.z);
      const f = 0.82 + 0.12 * Math.sin(time * 11.0 + this.flicker[i]) + 0.06 * Math.sin(time * 23.0 + this.flicker[i] * 2.0);
      const base = s.kind === 'brazier' ? 26 : 12;
      l.intensity = base * level * f;
      l.distance = s.kind === 'brazier' ? 26 : 18;
    });
  }
}
