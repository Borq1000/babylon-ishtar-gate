// Time-of-day presets and smooth transitions between them.
// Scene frame: north = +Z (behind the opening camera), south = -Z (the gate
// and the inner city), east = -X (left), west = +X (right).

import * as THREE from 'three';
import type { AtmosphereParams } from './Atmosphere';
import { cloneParams } from './Atmosphere';
import { easeInOutSine, lerp, saturate } from '../utils/math';

export type TimeKey = 'morning' | 'midday' | 'golden' | 'night';

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export const TIME_PRESETS: Record<TimeKey, AtmosphereParams> = {
  // Low sun from the east-north-east: light rakes the gate from the left,
  // cool fresh haze, busy birds.
  morning: {
    sunAzimuth: 78,
    sunElevation: 13,
    sunColor: C(1.0, 0.84, 0.66),
    sunIntensity: 3.6,
    moonAzimuth: 250,
    moonElevation: 20,
    moonColor: C(0.6, 0.7, 1.0),
    moonIntensity: 0,
    turbidity: 4.2,
    rayleigh: 1.45,
    mieCoefficient: 0.006,
    mieG: 0.8,
    skyScale: 0.62,
    hazeTint: C(1.0, 0.99, 0.98),
    night: 0,
    nightZenith: C(0.0025, 0.005, 0.014),
    nightHorizon: C(0.008, 0.012, 0.024),
    cloudCover: 0.22,
    envIntensity: 1.0,
    exposure: 1.0,
    fogDensity: 0.0011,
    fogHeight: 90,
    fogSunScatter: 1.0,
    fogAmbient: 1.0,
    groundAlbedo: C(0.48, 0.41, 0.31),
    lamps: 0,
    wind: 0.25,
    dust: 0.55,
    starIntensity: 0,
    sunDisk: 60,
    ambientFill: C(0.0, 0.0, 0.0),
  },
  // High Mesopotamian sun: short hard shadows, bleached warm haze.
  midday: {
    sunAzimuth: 160,
    sunElevation: 66,
    sunColor: C(1.0, 0.965, 0.91),
    sunIntensity: 5.6,
    moonAzimuth: 250,
    moonElevation: 20,
    moonColor: C(0.6, 0.7, 1.0),
    moonIntensity: 0,
    turbidity: 3.4,
    rayleigh: 1.0,
    mieCoefficient: 0.0045,
    mieG: 0.78,
    skyScale: 0.62,
    hazeTint: C(1.0, 0.985, 0.95),
    night: 0,
    nightZenith: C(0.0025, 0.005, 0.014),
    nightHorizon: C(0.008, 0.012, 0.024),
    cloudCover: 0.08,
    envIntensity: 1.0,
    exposure: 0.62,
    fogDensity: 0.0006,
    fogHeight: 260,
    fogSunScatter: 0.7,
    fogAmbient: 1.0,
    groundAlbedo: C(0.5, 0.43, 0.33),
    lamps: 0,
    wind: 0.5,
    dust: 0.7,
    starIntensity: 0,
    sunDisk: 40,
    ambientFill: C(0.0, 0.0, 0.0),
  },
  // The hero look: about an hour before sunset. NOTE: artistic licence — the sun is
  // placed further north-west (az 322°) than the true summer azimuth at Babylon
  // (≈295°) so that light reaches down the walled Processional Way onto the gate.
  golden: {
    sunAzimuth: 322,
    sunElevation: 13,
    sunColor: C(1.0, 0.67, 0.39),
    sunIntensity: 6.2,
    moonAzimuth: 120,
    moonElevation: 8,
    moonColor: C(0.6, 0.7, 1.0),
    moonIntensity: 0,
    turbidity: 3.8,
    rayleigh: 2.6,
    mieCoefficient: 0.0075,
    mieG: 0.86,
    skyScale: 0.62,
    hazeTint: C(1.02, 0.93, 0.9),
    night: 0,
    nightZenith: C(0.0025, 0.005, 0.014),
    nightHorizon: C(0.008, 0.012, 0.024),
    cloudCover: 0.46,
    envIntensity: 0.72,
    exposure: 1.3,
    fogDensity: 0.00062,
    fogHeight: 200,
    fogSunScatter: 1.0,
    fogAmbient: 1.0,
    groundAlbedo: C(0.5, 0.41, 0.29),
    lamps: 0,
    wind: 0.42,
    dust: 1.0,
    starIntensity: 0,
    sunDisk: 70,
    ambientFill: C(0.0, 0.0, 0.0),
  },
  // Moonlit Babylon: cold moonlight, sparse warm oil lamps and braziers.
  night: {
    sunAzimuth: 330,
    sunElevation: -24,
    sunColor: C(1.0, 0.6, 0.35),
    sunIntensity: 0,
    moonAzimuth: 128,
    moonElevation: 38,
    moonColor: C(0.62, 0.72, 1.0),
    moonIntensity: 0.3,
    turbidity: 4,
    rayleigh: 1.2,
    mieCoefficient: 0.005,
    mieG: 0.8,
    skyScale: 0.6,
    hazeTint: C(1.0, 1.0, 1.0),
    night: 1,
    nightZenith: C(0.0011, 0.0022, 0.0068),
    nightHorizon: C(0.0042, 0.0058, 0.0115),
    cloudCover: 0.12,
    envIntensity: 0.85,
    exposure: 2.0,
    fogDensity: 0.0007,
    fogHeight: 160,
    fogSunScatter: 0.6,
    fogAmbient: 1.0,
    groundAlbedo: C(0.45, 0.4, 0.33),
    lamps: 1,
    wind: 0.2,
    dust: 0.25,
    starIntensity: 1,
    sunDisk: 0,
    ambientFill: C(0.004, 0.005, 0.009),
  },
};

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

export function lerpParams(a: AtmosphereParams, b: AtmosphereParams, t: number, out: AtmosphereParams): AtmosphereParams {
  const keys = Object.keys(a) as (keyof AtmosphereParams)[];
  for (const k of keys) {
    const va = a[k] as unknown;
    const vb = b[k] as unknown;
    if (va instanceof THREE.Color && vb instanceof THREE.Color) {
      (out[k] as THREE.Color).copy(va).lerp(vb, t);
    } else if (typeof va === 'number' && typeof vb === 'number') {
      let v: number;
      if (k === 'sunAzimuth' || k === 'moonAzimuth') v = lerpAngle(va, vb, t);
      else v = lerp(va, vb, t);
      (out as unknown as Record<string, number>)[k] = v;
    }
  }
  return out;
}

export class TimeOfDay {
  current: TimeKey = 'golden';
  private from: AtmosphereParams;
  private to: AtmosphereParams;
  readonly state: AtmosphereParams;
  private t = 1;
  private duration = 3.5;
  /** True while a transition is running. */
  transitioning = false;
  onChange: ((key: TimeKey) => void) | null = null;

  constructor(initial: TimeKey = 'golden') {
    this.current = initial;
    this.from = cloneParams(TIME_PRESETS[initial]);
    this.to = cloneParams(TIME_PRESETS[initial]);
    this.state = cloneParams(TIME_PRESETS[initial]);
  }

  set(key: TimeKey, instant = false): void {
    if (key === this.current && !this.transitioning) return;
    this.current = key;
    this.from = cloneParams(this.state);
    this.to = cloneParams(TIME_PRESETS[key]);
    // Sunset/sunrise passes look nicer a little slower.
    this.duration = key === 'night' || this.from.night > 0.5 ? 5.0 : 3.5;
    this.t = instant ? 1 : 0;
    this.transitioning = !instant;
    if (instant) lerpParams(this.to, this.to, 1, this.state);
    this.onChange?.(key);
  }

  /** Returns true if the state changed this frame. */
  update(dt: number): boolean {
    if (!this.transitioning) return false;
    this.t = saturate(this.t + dt / this.duration);
    lerpParams(this.from, this.to, easeInOutSine(this.t), this.state);
    if (this.t >= 1) this.transitioning = false;
    return true;
  }
}
