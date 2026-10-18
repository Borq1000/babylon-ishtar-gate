// A low-cost, mostly static depth map rendered from the key light. It is used
// by the volumetric haze (light shafts between towers / through the gate) and
// by dust motes so they only sparkle where sunlight actually reaches.
// Only large static occluders (layer VOLUME_LAYER) are rendered into it.

import * as THREE from 'three';

export const VOLUME_LAYER = 2;

export class VolumeShadow {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera: THREE.OrthographicCamera;
  readonly matrix = new THREE.Matrix4();
  readonly uniforms = {
    uVolShadowMap: new THREE.Uniform<THREE.Texture | null>(null),
    uVolShadowMatrix: new THREE.Uniform(new THREE.Matrix4()),
    uVolShadowEnabled: new THREE.Uniform(0),
  };
  private center = new THREE.Vector3(1e9, 0, 0);
  private lightDir = new THREE.Vector3();
  private dirty = true;
  private overrideMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  private framesSince = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    size = 1024,
    private halfExtent = 230,
  ) {
    this.target = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const depth = new THREE.DepthTexture(size, size);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.target.depthTexture = depth;
    this.camera = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 1, 1200);
    this.camera.layers.set(VOLUME_LAYER);
    this.uniforms.uVolShadowMap.value = depth;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Re-renders when the light moved or the viewer left the covered area. */
  update(scene: THREE.Scene, viewerPos: THREE.Vector3, keyLightDir: THREE.Vector3): void {
    this.framesSince++;
    const moved = Math.hypot(viewerPos.x - this.center.x, viewerPos.z - this.center.z) > this.halfExtent * 0.3;
    const lightChanged = this.lightDir.dot(keyLightDir) < 0.99995;
    if (!this.dirty && !moved && !lightChanged) return;
    if (lightChanged && !moved && !this.dirty && this.framesSince < 6) return; // throttle during transitions
    this.framesSince = 0;
    this.dirty = false;
    // snap the centre to a coarse grid for temporal stability
    const snap = 16;
    this.center.set(Math.round(viewerPos.x / snap) * snap, 0, Math.round(viewerPos.z / snap) * snap);
    this.lightDir.copy(keyLightDir);

    const cam = this.camera;
    cam.position.copy(this.center).addScaledVector(keyLightDir, 600);
    cam.up.set(0, 1, 0);
    if (Math.abs(keyLightDir.y) > 0.98) cam.up.set(0, 0, 1);
    cam.lookAt(this.center);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const prevTarget = this.renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = this.renderer.autoClear;
    const prevBackground = scene.background;
    scene.overrideMaterial = this.overrideMat;
    scene.background = null;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, true, false);
    // shadow maps of the main lights are not needed for this pass
    const smEnabled = this.renderer.shadowMap.autoUpdate;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.render(scene, cam);
    this.renderer.shadowMap.autoUpdate = smEnabled;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.matrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.uniforms.uVolShadowMatrix.value.copy(this.matrix);
    this.uniforms.uVolShadowEnabled.value = 1;
  }

  dispose(): void {
    this.target.dispose();
    this.overrideMat.dispose();
  }
}
