// Renders procedural fragment shaders into (mipmapped) render-target textures
// once at load time. Texture generation on the GPU takes milliseconds, where the
// same work on the CPU would take seconds.

import * as THREE from 'three';

export interface BakeOptions {
  width: number;
  height: number;
  fragmentShader: string;
  uniforms?: Record<string, THREE.IUniform>;
  srgb?: boolean;
  type?: THREE.TextureDataType;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
  mipmaps?: boolean;
  name?: string;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class TextureBaker {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  readonly targets: THREE.WebGLRenderTarget[] = [];

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  bake(o: BakeOptions): THREE.Texture {
    const mip = o.mipmaps !== false;
    const rt = new THREE.WebGLRenderTarget(o.width, o.height, {
      type: o.type ?? THREE.UnsignedByteType,
      colorSpace: o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: mip,
      minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: o.wrap ?? THREE.RepeatWrapping,
      wrapT: o.wrap ?? THREE.RepeatWrapping,
      anisotropy: o.anisotropy ?? 8,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = o.name ?? 'baked';
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: o.fragmentShader,
      uniforms: o.uniforms ?? {},
      depthTest: false,
      depthWrite: false,
    });
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAutoClear;
    mat.dispose();
    this.targets.push(rt);
    return rt.texture;
  }

  dispose(): void {
    this.quad.geometry.dispose();
  }
}
