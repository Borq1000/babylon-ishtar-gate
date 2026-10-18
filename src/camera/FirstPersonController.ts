// First-person exploration at eye height: pointer-lock mouse look, WASD /
// arrow keys, Shift to hurry, smooth acceleration, a subtle head bob and 2D
// collisions against the architecture.

import * as THREE from 'three';
import type { CollisionWorld } from './Collision';
import { clamp, dampFactor } from '../utils/math';

export class FirstPersonController {
  enabled = false;
  yaw = 0; // 0 = facing -Z (south, towards the gate)
  pitch = 0.08;
  readonly position = new THREE.Vector3();
  private velocity = new THREE.Vector2();
  private keys = new Set<string>();
  private bob = 0;
  eyeHeight = 1.7;
  walkSpeed = 1.75;
  runSpeed = 4.6;
  sensitivity = 0.0021;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private collision: CollisionWorld,
  ) {
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = clamp(this.pitch - e.movementY * this.sensitivity, -1.45, 1.45);
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.dom;
      this.onLockChange?.(locked);
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.dom;
  }

  lock(): void {
    if (!this.locked) {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    }
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Takes over from the current camera pose. */
  syncFromCamera(): void {
    this.position.set(this.camera.position.x, 0, this.camera.position.z);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = clamp(Math.asin(clamp(dir.y, -1, 1)), -1.2, 1.2);
    this.velocity.set(0, 0);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const k = this.keys;
    let f = 0,
      s = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = run ? this.runSpeed : this.walkSpeed;
    const len = Math.hypot(f, s) || 1;
    // forward = -Z rotated by yaw
    const fx = -Math.sin(this.yaw),
      fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw),
      rz = -Math.sin(this.yaw);
    const tx = ((fx * f + rx * s) / len) * speed;
    const tz = ((fz * f + rz * s) / len) * speed;
    const a = dampFactor(f || s ? 7 : 9, dt);
    this.velocity.x += (tx - this.velocity.x) * a;
    this.velocity.y += (tz - this.velocity.y) * a;
    const [nx, nz] = this.collision.move(this.position.x, this.position.z, this.velocity.x * dt, this.velocity.y * dt, 0.32);
    this.position.x = nx;
    this.position.z = nz;
    const v = this.velocity.length();
    this.bob += dt * v * 2.1;
    const bobY = Math.sin(this.bob * 2) * 0.025 * Math.min(1, v / 2);
    const bobX = Math.cos(this.bob) * 0.012 * Math.min(1, v / 2);
    this.camera.position.set(this.position.x + bobX * Math.cos(this.yaw), this.eyeHeight + bobY, this.position.z - bobX * Math.sin(this.yaw));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
