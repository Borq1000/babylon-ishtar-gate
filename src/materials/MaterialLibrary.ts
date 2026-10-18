// Central material library: bakes procedural PBR sets, loads CC0 photo sets
// and builds the shared MeshStandardMaterials used throughout the city.

import * as THREE from 'three';
import { TextureBaker } from './TextureBaker';
import {
  bakeBrecciaPaving,
  bakeBrickPaving,
  bakeBuffBrick,
  bakeGlazedBrick,
  bakeLimestonePaving,
  bakeMacroNoise,
  lin,
  type PBRSet,
} from './BakedTextures';
import { patchMaterial } from './MaterialPatches';
import { bakeBand, type BandKind } from './BandTextures';
import { TURQ_PALETTE } from './BakedTextures';
import { ExternalTextures, type ExternalSet } from './ExternalTextures';
import type { QualitySettings } from '../core/Quality';

export class MaterialLibrary {
  readonly baker: TextureBaker;
  readonly external = new ExternalTextures();
  macro!: THREE.Texture;
  sets: Record<string, PBRSet> = {};
  ext: Record<string, ExternalSet | undefined> = {};

  glazed!: THREE.MeshStandardMaterial;
  buff!: THREE.MeshStandardMaterial;
  buffPlain!: THREE.MeshStandardMaterial;
  limestone!: THREE.MeshStandardMaterial;
  breccia!: THREE.MeshStandardMaterial;
  brickPave!: THREE.MeshStandardMaterial;
  ground!: THREE.MeshStandardMaterial;
  plaster!: THREE.MeshStandardMaterial;
  mudPlaster!: THREE.MeshStandardMaterial;
  wood!: THREE.MeshStandardMaterial;
  bronze!: THREE.MeshStandardMaterial;
  gold!: THREE.MeshStandardMaterial;
  bitumen!: THREE.MeshStandardMaterial;
  whitewash!: THREE.MeshStandardMaterial;
  glazedTurq!: THREE.MeshStandardMaterial;
  voidMat!: THREE.MeshStandardMaterial;
  bands = {} as Record<BandKind, THREE.MeshStandardMaterial>;
  bandSets = {} as Record<BandKind, PBRSet>;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private quality: QualitySettings,
  ) {
    this.baker = new TextureBaker(renderer);
  }

  async init(progress?: (f: number, label: string) => void): Promise<void> {
    const q = this.quality;
    const size = q.level === 'low' ? 1024 : 2048;
    const aniso = Math.min(q.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    progress?.(0.05, 'Firing glazed bricks');
    this.macro = bakeMacroNoise(this.baker, 512);
    this.sets.glazed = bakeGlazedBrick(this.baker, size, aniso);
    progress?.(0.12, 'Baking clay bricks');
    this.sets.buff = bakeBuffBrick(this.baker, size, aniso);
    progress?.(0.18, 'Cutting limestone');
    this.sets.limestone = bakeLimestonePaving(this.baker, size, aniso);
    this.sets.breccia = bakeBrecciaPaving(this.baker, size >= 2048 ? 1024 : 512, aniso);
    this.sets.brickPave = bakeBrickPaving(this.baker, size >= 2048 ? 1024 : 512, aniso);
    progress?.(0.2, 'Glazing ornamental bands');
    this.sets.glazedTurq = bakeGlazedBrick(this.baker, size >= 2048 ? 1024 : 512, aniso, TURQ_PALETTE);
    const ppm = q.level === 'low' ? 384 : 768;
    for (const k of ['rosette', 'checker', 'yellow', 'merlonBand', 'vborder'] as BandKind[]) this.bandSets[k] = bakeBand(this.baker, k, ppm, aniso);

    progress?.(0.22, 'Gathering earth and timber');
    await this.external.loadManifest();
    const slots = ['ground_sand', 'ground_dirt', 'plaster', 'wood', 'fabric', 'stone', 'bark'];
    const loaded = await Promise.all(slots.map((s) => this.external.loadSlot(s, aniso)));
    slots.forEach((s, i) => (this.ext[s] = loaded[i]));

    this.buildMaterials();
  }

  private fromSet(set: PBRSet, opts: { envMapIntensity?: number; normalScale?: number } = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.orm,
      aoMap: set.orm,
      aoMapIntensity: 1,
      metalness: 0,
      roughness: 1,
      envMapIntensity: opts.envMapIntensity ?? 1,
    });
    m.normalScale.setScalar(opts.normalScale ?? 1);
    return m;
  }

  private buildMaterials(): void {
    const q = this.quality;
    const reliefSteps = q.reliefShadowSteps;
    const macro = this.macro;
    const dust = lin(0xb39b78);

    // Glazed façade brick — glossy, reflective, subtle dust at the foot.
    this.glazed = this.fromSet(this.sets.glazed, { envMapIntensity: 1.0 });
    patchMaterial(this.glazed, {
      weathering: { macro, macroScale: 0.03, macroStrength: 0.35, dustColor: dust, dustHeight: 0.7, dustStrength: 0.5, topDust: 0.45, streaks: 0.06 },
      bricks: { space: 'world', value: 0.045, saturation: 0.08, roughness: 0.04 },
      relief:
        q.level === 'low'
          ? undefined
          : {
              heightMap: this.sets.glazed.orm,
              heightScale: this.sets.glazed.heightScale,
              uvPerMetre: new THREE.Vector2(1 / this.sets.glazed.tile.x, 1 / this.sets.glazed.tile.y),
              steps: Math.max(4, Math.round(reliefSteps * 0.5)),
              softness: 5,
            },
    });

    // Unglazed buff baked brick with bitumen joints.
    this.buff = this.fromSet(this.sets.buff, { envMapIntensity: 0.9 });
    patchMaterial(this.buff, {
      weathering: { macro, macroScale: 0.025, macroStrength: 0.6, dustColor: dust, dustHeight: 1.2, dustStrength: 0.6, topDust: 0.7, streaks: 0.14 },
      bricks: { space: 'world', value: 0.05, saturation: 0.1, roughness: 0.05 },
      relief:
        q.level === 'low'
          ? undefined
          : {
              heightMap: this.sets.buff.orm,
              heightScale: this.sets.buff.heightScale,
              uvPerMetre: new THREE.Vector2(1 / this.sets.buff.tile.x, 1 / this.sets.buff.tile.y),
              steps: Math.max(4, Math.round(reliefSteps * 0.5)),
              softness: 5,
            },
    });
    // a cheaper variant for distant city mass
    this.buffPlain = this.fromSet(this.sets.buff, { envMapIntensity: 0.9 });
    patchMaterial(this.buffPlain, {
      weathering: { macro, macroScale: 0.02, macroStrength: 0.7, dustColor: dust, dustHeight: 1.5, dustStrength: 0.5, topDust: 0.7, streaks: 0.12 },
    });

    this.limestone = this.fromSet(this.sets.limestone, { envMapIntensity: 0.9 });
    patchMaterial(this.limestone, {
      weathering: { macro, macroScale: 0.015, macroStrength: 0.55, dustColor: dust, dustHeight: 0.0001, dustStrength: 0.0, topDust: 0.12, floor: 0.6 },
      relief:
        q.level === 'low'
          ? undefined
          : {
              heightMap: this.sets.limestone.orm,
              heightScale: this.sets.limestone.heightScale,
              uvPerMetre: new THREE.Vector2(1 / this.sets.limestone.tile.x, 1 / this.sets.limestone.tile.y),
              steps: Math.max(4, Math.round(reliefSteps * 0.5)),
              softness: 4,
            },
    });
    this.breccia = this.fromSet(this.sets.breccia, { envMapIntensity: 0.9 });
    patchMaterial(this.breccia, {
      weathering: { macro, macroScale: 0.015, macroStrength: 0.5, dustColor: dust, dustHeight: 0.0001, dustStrength: 0.0, topDust: 0.2, floor: 0.65 },
    });

    this.brickPave = this.fromSet(this.sets.brickPave, { envMapIntensity: 0.85 });
    patchMaterial(this.brickPave, {
      weathering: { macro, macroScale: 0.02, macroStrength: 0.6, dustColor: dust, dustHeight: 0.0001, dustStrength: 0.0, topDust: 0.35, floor: 0.75 },
    });

    // Ground: CC0 photo-scanned sand if available, otherwise a flat dusty tone.
    const sand = this.ext.ground_sand;
    this.ground = new THREE.MeshStandardMaterial({
      color: sand?.map ? 0xffffff : lin(0xb49a74).getHex(THREE.SRGBColorSpace),
      map: sand?.map ?? null,
      normalMap: sand?.normalMap ?? null,
      roughnessMap: sand?.roughnessMap ?? sand?.armMap ?? null,
      roughness: 1,
      metalness: 0,
    });
    patchMaterial(this.ground, {
      weathering: { macro, macroScale: 0.004, macroStrength: 0.9, dustColor: dust, dustHeight: 0.0001, dustStrength: 0.0, topDust: 0.0 },
    });

    const pl = this.ext.plaster;
    this.plaster = new THREE.MeshStandardMaterial({
      color: pl?.map ? lin(0xffffff).getHex(THREE.SRGBColorSpace) : lin(0xc9b28d).getHex(THREE.SRGBColorSpace),
      map: pl?.map ?? null,
      normalMap: pl?.normalMap ?? null,
      roughnessMap: pl?.roughnessMap ?? pl?.armMap ?? null,
      roughness: 1,
      metalness: 0,
    });
    patchMaterial(this.plaster, {
      weathering: { macro, macroScale: 0.03, macroStrength: 0.7, dustColor: dust, dustHeight: 1.0, dustStrength: 0.45, topDust: 0.5, streaks: 0.12, roof: 0.85 },
    });
    this.mudPlaster = this.plaster.clone();
    this.mudPlaster.color = lin(0xb89a76);
    patchMaterial(this.mudPlaster, {
      weathering: { macro, macroScale: 0.03, macroStrength: 0.8, dustColor: dust, dustHeight: 1.0, dustStrength: 0.45, topDust: 0.5, streaks: 0.12, roof: 0.85 },
    });
    this.whitewash = this.plaster.clone();
    this.whitewash.color = lin(0xf2ebdc);
    patchMaterial(this.whitewash, {
      weathering: { macro, macroScale: 0.03, macroStrength: 0.5, dustColor: dust, dustHeight: 1.4, dustStrength: 0.5, topDust: 0.4, streaks: 0.1, roof: 0.8 },
    });

    const wd = this.ext.wood;
    this.wood = new THREE.MeshStandardMaterial({
      color: wd?.map ? lin(0xb08a6a).getHex(THREE.SRGBColorSpace) : lin(0x5a3d26).getHex(THREE.SRGBColorSpace),
      map: wd?.map ?? null,
      normalMap: wd?.normalMap ?? null,
      roughnessMap: wd?.roughnessMap ?? wd?.armMap ?? null,
      roughness: 0.85,
      metalness: 0,
    });

    this.bronze = new THREE.MeshStandardMaterial({ color: lin(0xb07a45), metalness: 1, roughness: 0.38 });
    patchMaterial(this.bronze, { weathering: { macro, macroScale: 0.2, macroStrength: 0.6, dustColor: lin(0x4f7a62), dustHeight: 0.3, dustStrength: 0.0, topDust: 0.25 } });
    this.gold = new THREE.MeshStandardMaterial({ color: lin(0xe8b45a), metalness: 1, roughness: 0.26 });
    this.bitumen = new THREE.MeshStandardMaterial({ color: lin(0x2b2621), roughness: 0.6, metalness: 0 });
    this.voidMat = new THREE.MeshStandardMaterial({ color: 0x060504, roughness: 1, metalness: 0, envMapIntensity: 0 });

    this.glazedTurq = this.fromSet(this.sets.glazedTurq, { envMapIntensity: 1.0 });
    patchMaterial(this.glazedTurq, {
      weathering: { macro, macroScale: 0.03, macroStrength: 0.3, dustColor: dust, dustHeight: 0.7, dustStrength: 0.45, topDust: 0.3 },
      bricks: { space: 'world', value: 0.045, saturation: 0.08, roughness: 0.04 },
    });
    this.glazedTurq.polygonOffset = true;
    this.glazedTurq.polygonOffsetFactor = -1;
    this.glazedTurq.polygonOffsetUnits = -2;

    for (const [k, set] of Object.entries(this.bandSets) as [BandKind, PBRSet][]) {
      const m = this.fromSet(set, { envMapIntensity: 1.0 });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
      m.name = 'band:' + k;
      patchMaterial(m, {
        weathering: { macro, macroScale: 0.03, macroStrength: 0.3, dustColor: dust, dustHeight: 0.7, dustStrength: 0.45, topDust: 0.3 },
        bricks: { space: 'world', value: 0.06, saturation: 0.12, roughness: 0.03 },
        relief:
          q.level === 'low'
            ? undefined
            : {
                heightMap: set.orm,
                heightScale: set.heightScale,
                uvPerMetre: new THREE.Vector2(1 / set.tile.x, 1 / set.tile.y),
                steps: Math.max(4, Math.round(reliefSteps * 0.5)),
                softness: 5,
              },
      });
      this.bands[k] = m;
    }
  }
}
