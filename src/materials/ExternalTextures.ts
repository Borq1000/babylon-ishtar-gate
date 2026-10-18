// Loader for the locally stored CC0 Poly Haven texture sets (see ASSET_CREDITS.md).
// Every set is optional: if a file is missing, callers fall back to procedural maps.

import * as THREE from 'three';

export interface ManifestEntry {
  slot: string;
  id: string;
  name: string;
  type: 'texture' | 'model';
  files: string[];
  notes?: string;
  tile_m?: [number, number];
  gltf?: string;
}

export interface ExternalSet {
  id: string;
  /** Real-world size (m) covered by one texture repeat. */
  tile: [number, number];
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  armMap?: THREE.Texture;
}

const loader = new THREE.TextureLoader();

function loadTex(url: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture | undefined> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = anisotropy;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        resolve(t);
      },
      undefined,
      () => resolve(undefined),
    );
  });
}

export class ExternalTextures {
  private manifest: ManifestEntry[] = [];
  readonly sets = new Map<string, ExternalSet>();

  async loadManifest(): Promise<void> {
    try {
      const res = await fetch('/textures/ph/manifest.json');
      if (res.ok) this.manifest = (await res.json()) as ManifestEntry[];
    } catch {
      this.manifest = [];
    }
  }

  entry(slot: string): ManifestEntry | undefined {
    return this.manifest.find((e) => e.slot === slot && e.type === 'texture');
  }

  models(): ManifestEntry[] {
    return this.manifest.filter((e) => e.type === 'model');
  }

  async loadSlot(slot: string, anisotropy = 8): Promise<ExternalSet | undefined> {
    const e = this.entry(slot);
    if (!e) return undefined;
    const find = (key: string) => e.files.find((f) => f.toLowerCase().includes(`_${key}_`));
    const url = (f: string) => '/' + f.replace(/^\/+/, '').replace(/^public\//, '');
    const diff = find('diff');
    const nor = find('nor_gl');
    const rough = find('rough');
    const ao = find('ao');
    const arm = find('arm');
    const [map, normalMap, roughnessMap, aoMap, armMap] = await Promise.all([
      diff ? loadTex(url(diff), true, anisotropy) : undefined,
      nor ? loadTex(url(nor), false, anisotropy) : undefined,
      rough ? loadTex(url(rough), false, anisotropy) : undefined,
      ao ? loadTex(url(ao), false, anisotropy) : undefined,
      arm ? loadTex(url(arm), false, anisotropy) : undefined,
    ]);
    const set: ExternalSet = { id: e.id, tile: e.tile_m ?? [2, 2], map, normalMap, roughnessMap, aoMap, armMap };
    this.sets.set(slot, set);
    return set;
  }
}
