// Orchestrates the whole experience: loading, world, camera modes, effects,
// night lights, audio and the UI.

import * as THREE from 'three';
import { App } from './core/App';
import { guessQuality, type QualityLevel } from './core/Quality';
import { World } from './world/World';
import { LAYOUT } from './world/Layout';
import { UI } from './ui/UI';
import { CameraRig, type CamMode } from './camera/CameraRig';
import { NightLights, type LampSpot } from './environment/NightLights';
import { Dust } from './environment/Dust';
import { Smoke } from './environment/Smoke';
import { Birds } from './environment/Birds';
import { Market, type StallSpot } from './environment/Market';
import { windUniforms } from './environment/Palms';
import type { TimeKey } from './environment/TimeOfDay';
import { Soundscape } from './audio/Soundscape';

export class Experience {
  app!: App;
  world!: World;
  ui!: UI;
  rig!: CameraRig;
  lights!: NightLights;
  dust!: Dust;
  smoke!: Smoke;
  birds!: Birds;
  market!: Market;
  sound!: Soundscape;
  private listener = new THREE.AudioListener();
  private censerEmitters: number[] = [];
  private brazierEmitters: number[] = [];
  private soundWanted = false;

  async boot(canvas: HTMLCanvasElement): Promise<void> {
    const params = new URLSearchParams(location.search);
    const gl = document.createElement('canvas').getContext('webgl2');
    const quality = (params.get('q') as QualityLevel | null) ?? guessQuality(gl);

    this.ui = new UI({
      enter: () => this.enter('tour'),
      tour: () => this.enter('tour'),
      explore: () => this.enter('explore'),
      title: () => this.toTitle(),
      time: (k) => this.setTime(k),
      quality: (q) => this.setQuality(q),
      sound: (on) => this.setSound(on),
    });
    this.ui.setQuality(quality);
    this.ui.setTime('golden');

    const app = (this.app = new App(canvas, quality));
    app.camera.add(this.listener);
    const t0 = performance.now();
    const world = (this.world = new World(app));
    await world.build((f, l) => this.ui.setProgress(f * 0.9, l));

    // ---------------------------------------------------------- effects
    this.ui.setProgress(0.9, 'Lighting the lamps');
    const spots: LampSpot[] = [...world.monuments.lampSpots, ...world.city.lampSpots.map((p) => ({ pos: p, kind: 'brazier' as const }))];
    this.lights = new NightLights(spots, world.mats, app.quality.level === 'low' ? 4 : app.quality.level === 'ultra' ? 10 : 7);
    app.scene.add(this.lights.group);

    this.dust = new Dust(6000, app.volume);
    this.dust.setFraction(app.quality.dustFraction);
    app.scene.add(this.dust.points);

    this.smoke = new Smoke();
    const hearths = world.city.smokeSpots
      .slice()
      .sort((a, b) => a.distanceTo(new THREE.Vector3(0, 0, -150)) - b.distanceTo(new THREE.Vector3(0, 0, -150)))
      .filter((_, i) => i % 2 === 0)
      .slice(0, 14);
    for (const h of hearths) this.smoke.add(h, 'hearth');
    for (let i = 0; i < world.crowd.censers.length; i++) this.censerEmitters.push(this.smoke.add(new THREE.Vector3(), 'censer'));
    for (const s of spots) if (s.kind === 'brazier') this.brazierEmitters.push(this.smoke.add(s.pos.clone().add(new THREE.Vector3(0, 0.7, 0)), 'brazier'));
    this.smoke.build();
    app.scene.add(this.smoke.mesh);

    this.birds = new Birds([
      { x: 0, z: -30, h: 55, r: 46, n: 22 },
      { x: 120, z: -200, h: 70, r: 70, n: 18 },
      { x: -140, z: 60, h: 48, r: 60, n: 16 },
      { x: 110, z: -640, h: 120, r: 90, n: 14 },
    ]);
    app.scene.add(this.birds.mesh);

    const stalls: StallSpot[] = [];
    for (let z = -60; z > -104; z -= 6.5) stalls.push({ x: 17.5, z, rot: -Math.PI / 2 });
    for (let x = -54; x < -14; x += 7) if (Math.abs(x - LAYOUT.city.ninmah.x) > 8) stalls.push({ x, z: -57, rot: Math.PI });
    this.market = new Market(world.mats, stalls);
    await this.market.build();
    app.scene.add(this.market.group);
    const colliders = [...world.monuments.colliders, ...world.city.colliders];
    for (const s of stalls) colliders.push({ x0: s.x - 1.6, z0: s.z - 1.4, x1: s.x + 1.6, z1: s.z + 1.4 });

    // ---------------------------------------------------------- camera
    this.rig = new CameraRig(app.camera, canvas, colliders);
    this.rig.tour.onLabel = (l) => this.ui.showCaption(l);
    this.rig.onModeChange = (m) => this.onMode(m);
    this.rig.fps.onLockChange = (locked) => this.ui.setHint(!locked);
    canvas.addEventListener('click', () => {
      if (this.rig.mode === 'explore') this.rig.fps.lock();
    });

    // ---------------------------------------------------------- audio
    this.sound = new Soundscape(this.listener, app.scene);
    this.sound.setTimeOfDay('golden');
    for (const c of world.crowd.crowdSpots) this.sound.addCrowdEmitter(c, 1 + Math.random());
    for (const s of spots) this.sound.addFireEmitter(s.pos);
    for (const w of world.water.emitterSpots) this.sound.addWaterEmitter(w);
    const birdSpots = [new THREE.Vector3(-14, 13, 40), new THREE.Vector3(14, 13, 110), new THREE.Vector3(-22, 22, -60), new THREE.Vector3(30, 20, -100), new THREE.Vector3(0, 24, -6), new THREE.Vector3(-30, 14, 170)];
    for (const b of birdSpots) this.sound.addBirdEmitter(b);

    // ---------------------------------------------------------- loop wiring
    app.timeOfDay.onChange = (k) => {
      this.sound.setTimeOfDay(k);
      this.ui.setTime(k);
    };
    app.preUpdate.push((dt) => {
      this.rig.update(dt);
    });
    app.updatables.push({
      update: (dt, time) => {
        world.update(app.camera, dt, time);
        const atmo = app.atmosphere;
        const p = atmo.params;
        windUniforms.uWind.value = p.wind;
        this.lights.update(dt, time, p.lamps, app.camera.position);
        this.market.update(app.camera.position);
        this.dust.update(app.camera, atmo, app.renderer.domElement.height);
        this.smoke.update(atmo);
        // incense follows the priests; braziers smoke at night
        world.crowd.censers.forEach((c, i) => this.smoke.setEmitter(this.censerEmitters[i], c, c.z < 230 && c.z > -330));
        for (const e of this.brazierEmitters) this.smoke.setEmitter(e, null, p.lamps > 0.2);
        this.birds.update(p.night, p.skyScale * (1 - p.night));
        this.sound.setWind(p.wind);
        this.sound.setProcession(world.crowd.processionPos, true);
        this.sound.update(dt, app.camera.position);
        this.ui.update(dt, this.rig.fps.locked);
        const info = app.renderer.info.render;
        this.ui.setStats(`${app.stats.fps.toFixed(0)} fps · ${app.stats.frameMs.toFixed(1)} ms · scale ${app.dynRes.scale.toFixed(2)}\n${info.calls} calls · ${(info.triangles / 1e6).toFixed(2)} M tris\n${app.quality.level}`);
      },
    });

    this.ui.setProgress(0.96, 'Compiling shaders');
    await app.precompile();
    this.rig.update(0);
    app.start();
    this.ui.setProgress(1, 'Ready');
    this.ui.ready();
    console.log('[babylon] ready in', Math.round(performance.now() - t0), 'ms');

    // optional deep links for screenshots / debugging
    const time = params.get('time') as TimeKey | null;
    if (time) this.setTime(time, true);
    const cam = params.get('cam');
    if (cam) {
      const [x, y, z, tx, ty, tz] = cam.split(',').map(Number);
      this.rig.mode = 'explore';
      this.rig.fps.enabled = false;
      app.camera.position.set(x, y, z);
      app.camera.lookAt(tx, ty, tz);
      this.rig.update = () => undefined;
      this.ui.showExperience('explore');
      this.ui.setHidden(true);
    }
    if (params.has('tour')) this.enter('tour');
  }

  private enter(mode: 'tour' | 'explore'): void {
    // the first click is the user gesture that may start audio
    if (!this.soundWanted && !this.sound.started) {
      this.soundWanted = true;
      this.setSound(true);
      this.ui.setSound(true);
    }
    if (mode === 'tour') {
      void this.ui.fadeCut(() => {
        this.world.crowd.setProcessionHead(56);
        this.rig.setMode('tour');
      });
    } else {
      if (this.rig.mode === 'intro') this.world.crowd.setProcessionHead(22);
      this.rig.setMode('explore');
    }
    this.ui.showExperience(mode);
  }

  private toTitle(): void {
    this.rig.setMode('intro');
    this.ui.showTitle();
  }

  private onMode(m: CamMode): void {
    // during the tour passers-by keep their distance from the lens
    this.world.crowd.cameraClearance = m === 'tour' ? 4 : 0;
    if (m === 'explore') this.ui.showExperience('explore');
    else if (m === 'tour') this.ui.showExperience('tour');
  }

  setTime(k: TimeKey, instant = false): void {
    this.app.setTime(k, instant);
    this.ui.setTime(k);
  }

  setQuality(q: QualityLevel): void {
    this.app.setQuality(q);
    this.dust.setFraction(this.app.quality.dustFraction);
    this.ui.setQuality(q);
  }

  setSound(on: boolean): void {
    if (on) {
      void this.sound.start().then(() => this.sound.setMuted(false));
    } else if (this.sound.started) {
      this.sound.setMuted(true);
    }
  }
}
