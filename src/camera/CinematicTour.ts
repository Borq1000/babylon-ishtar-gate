// Spline-based cinematic tour. Positions and look-at targets are centripetal
// Catmull-Rom curves through keyframes; time is mapped to the curve parameter
// with a monotone cubic (Fritsch–Carlson) so speed changes smoothly without
// stopping at keyframes, easing in and out at the ends.

import * as THREE from 'three';

export interface TourKey {
  t: number;
  pos: [number, number, number];
  look: [number, number, number];
  fov: number;
  label?: string;
}

/** Monotone cubic interpolation through (x_i, y_i), with zero end slopes. */
class Monotone {
  private m: number[];
  constructor(
    private xs: number[],
    private ys: number[],
  ) {
    const n = xs.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    const m = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    m[0] = 0;
    m[n - 1] = 0;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i],
        b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const tt = 3 / Math.sqrt(h);
        m[i] = tt * a * d[i];
        m[i + 1] = tt * b * d[i];
      }
    }
    this.m = m;
  }
  at(x: number): number {
    const xs = this.xs,
      ys = this.ys,
      m = this.m;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t,
      t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  }
}

export const TOUR_KEYS: TourKey[] = [
  { t: 0, pos: [-14, 48, 350], look: [0, 6, 150], fov: 44, label: 'The Processional Way' },
  { t: 7, pos: [-7, 24, 240], look: [0, 4, 130], fov: 40 },
  { t: 13, pos: [-6.2, 3.3, 168], look: [-10.4, 1.9, 140], fov: 34, label: 'The lions of Ishtar' },
  { t: 19, pos: [-7.2, 2.3, 138], look: [-10.6, 1.7, 116], fov: 32 },
  { t: 25, pos: [-4.8, 1.9, 104], look: [0, 2.2, 78], fov: 40, label: 'The Akitu procession' },
  { t: 31, pos: [7.4, 1.8, 80], look: [0.5, 2.4, 56], fov: 44 },
  { t: 37, pos: [7.8, 2.1, 49], look: [0.4, 3.0, 40], fov: 46 },
  { t: 42, pos: [2.0, 1.9, 18], look: [0, 15, -1], fov: 54, label: 'The Ishtar Gate' },
  { t: 47, pos: [0, 19, 36], look: [0, 11, -14], fov: 50 },
  { t: 51.5, pos: [0, 4.2, 9], look: [0, 3.6, -20], fov: 50 },
  { t: 55, pos: [0, 2.6, -24], look: [0, 3.0, -60], fov: 54, label: 'Into the city' },
  { t: 59, pos: [0.5, 9, -64], look: [40, 18, -320], fov: 46 },
  { t: 65, pos: [-18, 42, -110], look: [100, 46, -640], fov: 38, label: 'Babylon' },
];

export class CinematicTour {
  readonly duration: number;
  private posCurve: THREE.CatmullRomCurve3;
  private lookCurve: THREE.CatmullRomCurve3;
  private timeToU: Monotone;
  private fovs: Monotone;
  time = 0;
  playing = false;
  onEnd: (() => void) | null = null;
  onLabel: ((label: string) => void) | null = null;
  private lastLabel = -1;

  constructor(private keys: TourKey[] = TOUR_KEYS) {
    this.duration = keys[keys.length - 1].t;
    this.posCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(...k.pos)), false, 'centripetal');
    this.lookCurve = new THREE.CatmullRomCurve3(keys.map((k) => new THREE.Vector3(...k.look)), false, 'centripetal');
    const ts = keys.map((k) => k.t);
    this.timeToU = new Monotone(ts, keys.map((_, i) => i / (keys.length - 1)));
    this.fovs = new Monotone(ts, keys.map((k) => k.fov));
  }

  start(): void {
    this.time = 0;
    this.playing = true;
    this.lastLabel = -1;
  }

  stop(): void {
    this.playing = false;
  }

  /** Writes the camera pose for the current time; returns false when finished. */
  update(dt: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.playing) return false;
    this.time += dt;
    const t = Math.min(this.time, this.duration);
    const u = this.timeToU.at(t);
    const p = this.posCurve.getPoint(u);
    const l = this.lookCurve.getPoint(u);
    camera.position.copy(p);
    camera.up.set(0, 1, 0);
    camera.lookAt(l);
    const fov = this.fovs.at(t);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // section titles
    for (let i = this.keys.length - 1; i >= 0; i--) {
      if (t >= this.keys[i].t) {
        if (i !== this.lastLabel && this.keys[i].label) {
          this.lastLabel = i;
          this.onLabel?.(this.keys[i].label!);
        }
        break;
      }
    }
    if (this.time >= this.duration) {
      this.playing = false;
      this.onEnd?.();
      return false;
    }
    return true;
  }
}
