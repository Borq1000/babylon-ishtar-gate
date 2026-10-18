// Sky dome + image-based lighting capture.
// The same sky shader is rendered (a) as the visible dome and (b) into a small
// cube map that is PMREM-filtered into scene.environment, so the glazed bricks
// reflect exactly the sky the viewer sees.

import * as THREE from 'three';
import { skyFragmentShader, skyVertexShader } from '../shaders/sky.glsl';
import type { Atmosphere } from './Atmosphere';

export class SkySystem {
  readonly dome: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private envMaterial: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  readonly localUniforms = {
    uTime: { value: 0 },
    uSunDiskColor: { value: new THREE.Color(1, 0.9, 0.75) },
    uCloudCover: { value: 0.3 },
    uCloudLit: { value: new THREE.Color(1, 0.8, 0.6) },
    uCloudShade: { value: new THREE.Color(0.5, 0.5, 0.6) },
    uGroundMode: { value: 0 },
    uGroundColor: { value: new THREE.Color(0.2, 0.17, 0.12) },
    uStarIntensity: { value: 0 },
  };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private atmosphere: Atmosphere,
  ) {
    const uniforms = { ...atmosphere.uniforms, ...this.localUniforms };
    this.material = new THREE.ShaderMaterial({
      name: 'SkyDome',
      uniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.dome.scale.setScalar(3000);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 100; // after opaque geometry: early-z rejects covered pixels
    this.dome.name = 'sky';

    // Env capture uses its own uniform for the lower hemisphere (ground bounce)
    // and no sun disc (the sun is handled by the analytic key light).
    const envUniforms = {
      ...atmosphere.uniforms,
      ...this.localUniforms,
      uGroundMode: { value: 1 },
      uSunDiskColor: { value: new THREE.Color(0, 0, 0) },
      uStarIntensity: { value: 0 },
    };
    this.envMaterial = new THREE.ShaderMaterial({
      name: 'SkyEnv',
      uniforms: envUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.envMaterial);
    envDome.frustumCulled = false;
    this.envScene.add(envDome);

    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
    });
    this.cubeCam = new THREE.CubeCamera(1, 1000, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  update(time: number, cameraPos: THREE.Vector3): void {
    this.localUniforms.uTime.value = time;
    this.dome.position.copy(cameraPos);
    const p = this.atmosphere.params;
    const lu = this.localUniforms;
    lu.uCloudCover.value = p.cloudCover;
    lu.uStarIntensity.value = p.starIntensity;
    // sun disc colour: intensity tuned for bloom; Fex in-shader adds reddening
    lu.uSunDiskColor.value.copy(p.sunColor).multiplyScalar(p.sunDisk);
    // cirrus lit by the low sun, shaded side picks up the sky
    const sunUp = Math.max(0, Math.min(1, (p.sunElevation + 4) / 10));
    lu.uCloudLit.value
      .copy(p.sunColor)
      .multiplyScalar((0.75 + 0.45 * p.skyScale) * sunUp)
      .add(new THREE.Color(0.02, 0.025, 0.04).multiplyScalar(p.night));
    lu.uCloudShade.value.setRGB(0.32, 0.3, 0.34).multiplyScalar(p.skyScale * sunUp + 0.02 * p.night);
    lu.uGroundColor.value.copy(this.atmosphere.groundColor);
    (this.envMaterial.uniforms.uGroundColor.value as THREE.Color).copy(this.atmosphere.groundColor);
    this.envMaterial.uniforms.uCloudCover.value = p.cloudCover;
  }

  /** Re-renders the sky into the PMREM environment map. ~1–2 ms. */
  captureEnvironment(): THREE.Texture {
    this.cubeCam.update(this.renderer, this.envScene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    return this.envRT.texture;
  }

  dispose(): void {
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.material.dispose();
    this.envMaterial.dispose();
  }
}
