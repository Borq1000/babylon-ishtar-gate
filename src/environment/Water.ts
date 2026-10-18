// Water for the moat and the Euphrates: a glossy PBR surface whose two
// scrolling, GPU-baked ripple normal maps reflect the sky environment and the
// low sun; silt-laden colour, brick embankments for the moat, muddy banks and
// reed beds along the river.

import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/common.glsl';
import type { TextureBaker } from '../materials/TextureBaker';
import { patchMaterial, sharedUniforms } from '../materials/MaterialPatches';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import { LAYOUT } from '../world/Layout';
import { applyWorldUV, boxMinMax, merge } from '../utils/geometry';

function bakeRippleNormal(baker: TextureBaker): THREE.Texture {
  const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
${NOISE_GLSL}
float H(vec2 p) {
  float h = 0.0;
  h += fbmP(p * 6.0, vec2(6.0), 4) * 0.6;
  h += fbmP(p * 17.0 + 3.0, vec2(17.0), 3) * 0.25;
  h += sin((p.x * 22.0 + fbmP(p * 3.0, vec2(3.0), 3) * 6.0) * 6.2831) * 0.04;
  return h;
}
void main() {
  float e = 1.0 / 512.0;
  float hx = H(vUv + vec2(e, 0.0)) - H(vUv - vec2(e, 0.0));
  float hy = H(vUv + vec2(0.0, e)) - H(vUv - vec2(0.0, e));
  vec3 n = normalize(vec3(-hx * 18.0, -hy * 18.0, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;
  return baker.bake({ width: 512, height: 512, fragmentShader: frag, name: 'waterNormal' });
}

export class Water {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly emitterSpots: THREE.Vector3[] = [];

  constructor(baker: TextureBaker, private mats: MaterialLibrary) {
    this.group.name = 'water';
    const normal = bakeRippleNormal(baker);
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x3a4530, THREE.SRGBColorSpace),
      roughness: 0.06,
      metalness: 0.0,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 1.25,
    });
    this.material.name = 'water';
    // second ripple layer, scrolled in another direction, added in the shader
    const prev = this.material.onBeforeCompile;
    this.material.onBeforeCompile = (shader, r) => {
      prev.call(this.material, shader, r);
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_maps>',
          `{
            vec2 uvA = vNormalMapUv + vec2(uTime * 0.011, uTime * 0.004);
            vec2 uvB = vNormalMapUv * 1.7 + vec2(-uTime * 0.007, uTime * 0.013);
            vec3 nA = texture2D(normalMap, uvA).xyz * 2.0 - 1.0;
            vec3 nB = texture2D(normalMap, uvB).xyz * 2.0 - 1.0;
            vec3 mapN = normalize(vec3((nA.xy + nB.xy) * normalScale, 1.0));
            normal = normalize(tbn * mapN);
          }`,
        );
    };
    const prevKey = this.material.customProgramCacheKey.bind(this.material);
    this.material.customProgramCacheKey = () => prevKey() + '|water';
    patchMaterial(this.material, { extraKey: 'water' });
  }

  private plane(x0: number, z0: number, x1: number, z1: number, y: number, tile = 18): THREE.Mesh {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1).rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / tile, -pos.getZ(i) / tile);
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    return m;
  }

  build(): void {
    const M = LAYOUT.moat;
    const level = -2.2;
    // the moat, 80 m wide, lined with baked-brick embankments
    this.group.add(this.plane(-1600, M.z0, 1600, M.z1, level));
    const banks = merge([
      applyWorldUV(boxMinMax(-1600, -6, M.z0 - 3, 1600, 0.0, M.z0), 2),
      applyWorldUV(boxMinMax(-1600, -6, M.z1, 1600, 0.0, M.z1 + 3), 2),
    ]);
    const bankMesh = new THREE.Mesh(banks, this.mats.buffPlain);
    bankMesh.receiveShadow = true;
    this.group.add(bankMesh);
    // the Euphrates to the west, ~180 m wide, flowing south
    const rx = LAYOUT.city.euphratesX;
    this.group.add(this.plane(rx - 40, -4000, rx + 160, 4000, -3.0, 24));
    // the ground is cut away under the water by a darker bank strip
    const bankGeo = merge([
      applyWorldUV(boxMinMax(rx - 46, -6, -4000, rx - 40, -0.05, 4000), 2),
      applyWorldUV(boxMinMax(rx + 160, -6, -4000, rx + 166, -0.05, 4000), 2),
    ]);
    const river = new THREE.Mesh(bankGeo, this.mats.mudPlaster);
    river.receiveShadow = true;
    this.group.add(river);
    for (let z = -60; z < 260; z += 34) this.emitterSpots.push(new THREE.Vector3(z % 68 === 0 ? 40 : -40, -1, M.z0 + 2));
  }
}
