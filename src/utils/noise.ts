// CPU-side 2D gradient noise + fBm, used for procedural geometry
// (terrain undulation, crowd variation) and CPU texture generation.

import { rng } from './math';

export class Noise2D {
  private perm = new Uint8Array(512);
  private grads: Float32Array;

  constructor(seed = 1337) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.grads = new Float32Array(512);
    for (let i = 0; i < 256; i++) {
      const a = r() * Math.PI * 2;
      this.grads[i * 2] = Math.cos(a);
      this.grads[i * 2 + 1] = Math.sin(a);
    }
  }

  private dot(ix: number, iy: number, x: number, y: number): number {
    const h = this.perm[(ix & 255) + this.perm[iy & 255]];
    return this.grads[h * 2] * x + this.grads[h * 2 + 1] * y;
  }

  /** Gradient noise in roughly [-0.7, 0.7]. */
  noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const n00 = this.dot(ix, iy, fx, fy);
    const n10 = this.dot(ix + 1, iy, fx - 1, fy);
    const n01 = this.dot(ix, iy + 1, fx, fy - 1);
    const n11 = this.dot(ix + 1, iy + 1, fx - 1, fy - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  }

  fbm(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      freq *= lacunarity;
      amp *= gain;
    }
    return sum;
  }
}

export const noise = new Noise2D(20251);
