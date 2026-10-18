// Camera modes: an idle cinematic drift behind the title screen, the spline
// tour, and first-person exploration — with smooth pose blends between them.

import * as THREE from 'three';
import { CinematicTour } from './CinematicTour';
import { FirstPersonController } from './FirstPersonController';
import { CollisionWorld } from './Collision';
import type { Box2 } from '../architecture/Monuments';
import { LAYOUT } from '../world/Layout';
import { easeInOutCubic } from '../utils/math';

export type CamMode = 'intro' | 'tour' | 'explore';

interface Blend {
  fromPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  fromFov: number;
  t: number;
  dur: number;
}

/** The area prepared for walking (union of rectangles). */
export const WALKABLE: Box2[] = [
  { x0: -10.6, z0: -56, x1: 10.6, z1: 214 }, // Processional Way, gates
  { x0: -6.6, z0: 178, x1: 6.6, z1: 300 }, // North Gate and the moat causeway
  { x0: -64, z0: -114, x1: 22, z1: -48 }, // plaza before the South Palace / Ninmah
  { x0: -10.6, z0: -470, x1: 10.6, z1: -48 }, // the street into the city
];

export class CameraRig {
  mode: CamMode = 'intro';
  readonly tour: CinematicTour;
  readonly fps: FirstPersonController;
  private introT = 0;
  private blend: Blend | null = null;
  onModeChange: ((m: CamMode) => void) | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    colliders: Box2[],
  ) {
    this.tour = new CinematicTour();
    this.fps = new FirstPersonController(camera, dom, new CollisionWorld(colliders, WALKABLE));
    this.tour.onEnd = () => this.setMode('explore', { x: 0.5, z: -62, yaw: 0.0 });
  }

  private startBlend(dur: number): void {
    this.blend = {
      fromPos: this.camera.position.clone(),
      fromQuat: this.camera.quaternion.clone(),
      fromFov: this.camera.fov,
      t: 0,
      dur,
    };
  }

  setMode(mode: CamMode, at?: { x: number; z: number; yaw: number }): void {
    const prev = this.mode;
    this.mode = mode;
    this.fps.enabled = mode === 'explore';
    if (mode !== 'explore') this.fps.unlock();
    if (mode === 'tour') {
      this.blend = null;
      this.tour.start();
    } else if (mode === 'explore') {
      if (prev === 'tour') this.tour.stop();
      this.startBlend(prev === 'intro' ? 1.4 : 2.2);
      if (at) {
        this.fps.position.set(at.x, 0, at.z);
        this.fps.yaw = at.yaw;
        this.fps.pitch = 0.05;
      } else {
        this.fps.syncFromCamera();
        const s = LAYOUT.start;
        if (prev === 'intro') {
          this.fps.position.set(s.x, 0, s.z);
          this.fps.yaw = 0.0;
          this.fps.pitch = 0.1;
        }
      }
    } else if (mode === 'intro') {
      this.startBlend(2.0);
      this.introT = 0;
    }
    this.onModeChange?.(mode);
  }

  private introPose(t: number): void {
    // slow, breathing dolly down the Processional Way towards the gate
    const k = 0.5 - 0.5 * Math.cos((t / 70) * Math.PI * 2);
    const x = THREE.MathUtils.lerp(-3.4, -1.2, k);
    const y = THREE.MathUtils.lerp(3.3, 1.9, k) + Math.sin(t * 0.21) * 0.06;
    const z = THREE.MathUtils.lerp(124, 98, k);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(Math.sin(t * 0.05) * 0.8, 9.4 + Math.sin(t * 0.13) * 0.25, 0);
    if (Math.abs(this.camera.fov - 40) > 0.01) {
      this.camera.fov = 40;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number): void {
    if (this.mode === 'intro') {
      this.introT += dt;
      this.introPose(this.introT);
    } else if (this.mode === 'tour') {
      this.tour.update(dt, this.camera);
    } else {
      this.fps.update(dt);
      const targetFov = 50;
      if (Math.abs(this.camera.fov - targetFov) > 0.01 && !this.blend) {
        this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 3);
        this.camera.updateProjectionMatrix();
      }
    }
    if (this.blend) {
      const b = this.blend;
      b.t += dt;
      const k = easeInOutCubic(Math.min(1, b.t / b.dur));
      const toPos = this.camera.position.clone();
      const toQuat = this.camera.quaternion.clone();
      const toFov = this.mode === 'explore' ? 50 : this.camera.fov;
      this.camera.position.lerpVectors(b.fromPos, toPos, k);
      this.camera.quaternion.slerpQuaternions(b.fromQuat, toQuat, k);
      this.camera.fov = THREE.MathUtils.lerp(b.fromFov, toFov, k);
      this.camera.updateProjectionMatrix();
      if (b.t >= b.dur) this.blend = null;
    }
  }
}
