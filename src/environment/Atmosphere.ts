// Shared atmosphere state: the single source of truth for sun/moon direction,
// sky scattering coefficients and haze. Uniform objects created here are shared
// by reference between the sky dome, env-map capture and the post-process fog,
// so they always stay in sync.

import * as THREE from 'three';
import { clamp, DEG } from '../utils/math';

export interface AtmosphereParams {
  sunAzimuth: number; // degrees, from north (+Z) clockwise towards east (-X)
  sunElevation: number; // degrees
  sunColor: THREE.Color;
  sunIntensity: number;
  moonAzimuth: number;
  moonElevation: number;
  moonColor: THREE.Color;
  moonIntensity: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieG: number;
  skyScale: number;
  hazeTint: THREE.Color;
  night: number;
  nightZenith: THREE.Color;
  nightHorizon: THREE.Color;
  cloudCover: number;
  envIntensity: number;
  exposure: number;
  fogDensity: number;
  fogHeight: number;
  fogSunScatter: number;
  fogAmbient: number;
  groundAlbedo: THREE.Color;
  lamps: number;
  wind: number;
  dust: number;
  starIntensity: number;
  sunDisk: number;
  ambientFill: THREE.Color;
}

export function cloneParams(p: AtmosphereParams): AtmosphereParams {
  return {
    ...p,
    sunColor: p.sunColor.clone(),
    moonColor: p.moonColor.clone(),
    hazeTint: p.hazeTint.clone(),
    nightZenith: p.nightZenith.clone(),
    nightHorizon: p.nightHorizon.clone(),
    groundAlbedo: p.groundAlbedo.clone(),
    ambientFill: p.ambientFill.clone(),
  };
}

/** Direction (unit vector, towards the body) from azimuth/elevation in degrees. */
export function dirFromAzEl(azDeg: number, elDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return out.set(-Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
}

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

export class Atmosphere {
  readonly uniforms = {
    uSunDir: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
    uBetaR: new THREE.Uniform(new THREE.Vector3()),
    uBetaM: new THREE.Uniform(new THREE.Vector3()),
    uSunE: new THREE.Uniform(1000),
    uMieG: new THREE.Uniform(0.8),
    uSkyScale: new THREE.Uniform(1),
    uNight: new THREE.Uniform(0),
    uMoonDir: new THREE.Uniform(new THREE.Vector3(0, 1, 0)),
    uNightZenith: new THREE.Uniform(new THREE.Color()),
    uNightHorizon: new THREE.Uniform(new THREE.Color()),
    uHazeTint: new THREE.Uniform(new THREE.Color(1, 1, 1)),
  };

  /** Direction towards the key light (sun by day, moon by night). */
  readonly keyLightDir = new THREE.Vector3(0, 1, 0);
  readonly keyLightColor = new THREE.Color();
  keyLightIntensity = 1;
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** Approximate irradiance-weighted colour of the lit ground (for env capture). */
  readonly groundColor = new THREE.Color();
  params!: AtmosphereParams;

  apply(p: AtmosphereParams): void {
    this.params = p;
    const u = this.uniforms;
    dirFromAzEl(p.sunAzimuth, p.sunElevation, this.sunDir);
    dirFromAzEl(p.moonAzimuth, p.moonElevation, this.moonDir);
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.copy(this.moonDir);

    const zen = Math.acos(clamp(this.sunDir.y, -1, 1));
    u.uSunE.value = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - zen) / 1.5)));
    u.uBetaR.value.set(TOTAL_RAYLEIGH[0], TOTAL_RAYLEIGH[1], TOTAL_RAYLEIGH[2]).multiplyScalar(p.rayleigh);
    const c = 0.2 * p.turbidity * 1e-17;
    u.uBetaM.value
      .set(MIE_CONST[0], MIE_CONST[1], MIE_CONST[2])
      .multiplyScalar(0.434 * c * p.mieCoefficient);
    u.uMieG.value = p.mieG;
    u.uSkyScale.value = p.skyScale;
    u.uNight.value = p.night;
    u.uNightZenith.value.copy(p.nightZenith);
    u.uNightHorizon.value.copy(p.nightHorizon);
    u.uHazeTint.value.copy(p.hazeTint);

    // Key light: the sun while it is up, the moon after dusk. The switch happens
    // while both intensities are ~0, so it is invisible during transitions.
    const sunUp = p.sunElevation > -3;
    if (sunUp) {
      const fade = clamp((p.sunElevation + 3) / 7, 0, 1);
      this.keyLightDir.copy(this.sunDir);
      this.keyLightColor.copy(p.sunColor);
      this.keyLightIntensity = p.sunIntensity * fade * fade * (3 - 2 * fade);
    } else {
      const fade = clamp((-3 - p.sunElevation) / 9, 0, 1);
      this.keyLightDir.copy(this.moonDir);
      this.keyLightColor.copy(p.moonColor);
      this.keyLightIntensity = p.moonIntensity * fade;
    }
    // keep the key light from grazing exactly along the ground (shadow acne)
    if (this.keyLightDir.y < 0.06) {
      this.keyLightDir.y = 0.06;
      this.keyLightDir.normalize();
    }

    const sunE = Math.max(this.sunDir.y, 0) * (sunUp ? this.keyLightIntensity : 0);
    const moonE = sunUp ? 0 : Math.max(this.moonDir.y, 0) * this.keyLightIntensity;
    const skyAmb = 0.35 * p.skyScale * (1 - p.night) + 0.02 * p.night;
    this.groundColor
      .setRGB(
        p.sunColor.r * sunE + p.moonColor.r * moonE + skyAmb,
        p.sunColor.g * sunE + p.moonColor.g * moonE + skyAmb,
        p.sunColor.b * sunE + p.moonColor.b * moonE + skyAmb * 1.1,
      )
      .multiply(p.groundAlbedo)
      // the surroundings are partly shadowed: scale the bounce from the lit plain
      .multiplyScalar(0.42 / Math.PI);
  }
}
