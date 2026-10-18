// Assembles the static world: materials, reliefs, monuments, city, water,
// palms and ground, and keeps per-frame systems (LODs) updated.

import * as THREE from 'three';
import type { App } from '../core/App';
import { MaterialLibrary } from '../materials/MaterialLibrary';
import { ReliefLibrary, ReliefPanels } from '../architecture/reliefs/ReliefLibrary';
import { RELIEF_KEYS, reliefDef } from '../architecture/reliefs/ReliefCatalog';
import { Monuments } from '../architecture/Monuments';
import { City } from '../architecture/City';
import { Palms } from '../environment/Palms';
import { Water } from '../environment/Water';
import { Crowd } from '../characters/Crowd';
import { loadPeople } from '../characters/People';
import { LAYOUT } from './Layout';
import { Random } from '../utils/math';

export type Progress = (f: number, label: string) => void;

export class World {
  readonly group = new THREE.Group();
  mats!: MaterialLibrary;
  reliefs!: ReliefLibrary;
  panels!: ReliefPanels;
  monuments!: Monuments;
  city!: City;
  palms!: Palms;
  water!: Water;
  crowd!: Crowd;
  ground!: THREE.Mesh;

  constructor(private app: App) {
    this.group.name = 'world';
    app.scene.add(this.group);
  }

  async build(progress: Progress): Promise<void> {
    const app = this.app;
    this.mats = new MaterialLibrary(app.renderer, app.quality);
    await this.mats.init((f, l) => progress(f * 0.4, l));

    progress(0.42, 'Moulding lions, bulls and dragons');
    this.reliefs = new ReliefLibrary(app.quality, app.renderer, this.mats.macro);
    const maps = await this.reliefs.generateAll(RELIEF_KEYS, reliefDef);
    for (const k of RELIEF_KEYS) this.reliefs.build(k, reliefDef(k), maps.get(k));
    this.panels = new ReliefPanels(this.reliefs);
    this.panels.near = app.quality.reliefNear;
    this.panels.mid = app.quality.reliefMid;

    progress(0.55, 'Raising the Ishtar Gate');
    this.monuments = new Monuments(this.mats, this.reliefs, this.panels, { lionA: 'lionA', lionB: 'lionB', bull: 'bull', dragon: 'dragon' });
    this.monuments.build();
    this.panels.finalize();
    this.group.add(this.monuments.group, this.panels.group);

    progress(0.62, 'Building the houses of Babylon');
    await new Promise((r) => setTimeout(r, 0));
    this.city = new City(this.mats);
    this.city.build();
    this.group.add(this.city.group);

    progress(0.7, 'Filling the moat and the Euphrates');
    this.water = new Water(this.mats.baker, this.mats);
    this.water.build();
    this.group.add(this.water.group);

    progress(0.74, 'Planting date palms');
    this.palms = new Palms(this.mats);
    this.plantPalms();
    this.palms.build();
    this.group.add(this.palms.group);

    progress(0.78, 'Spreading the alluvial plain');
    this.buildGround();

    progress(0.8, 'Gathering the people of Babylon');
    const people = await loadPeople(app.renderer, (f) => progress(0.8 + 0.06 * f, 'Gathering the people of Babylon'));
    this.crowd = new Crowd(this.mats, people);
    this.crowd.build();
    this.crowd.fraction = app.quality.crowdFraction;
    this.group.add(this.crowd.group);

    app.onQualityChange.push((q) => {
      this.panels.near = q.reliefNear;
      this.panels.mid = q.reliefMid;
      this.crowd.fraction = q.crowdFraction;
    });
  }

  private plantPalms(): void {
    const rng = new Random(9);
    const M = LAYOUT.moat;
    const rx = LAYOUT.city.euphratesX;
    const p = this.palms;
    for (const s of this.city.palmSpots) p.add(s.x, s.z, s.s);
    const avoidCorridor = (x: number, z: number) => Math.abs(x) < 26 || (x > rx - 60 && x < rx + 180);
    // groves along both banks of the moat
    p.grove(-1500, M.z0 - 46, 1500, M.z0 - 7, 9, rng, (x, z) => avoidCorridor(x, z) || (z < 205 && Math.abs(x) < 240));
    p.grove(-1500, M.z1 + 8, 1500, M.z1 + 70, 9.5, rng, avoidCorridor);
    // date-palm gardens of the outer city
    p.grove(-1300, 360, -260, 760, 13, rng, (x, z) => rng.chance(0.35) || avoidCorridor(x, z));
    p.grove(60, 330, rx - 70, 700, 12, rng, (x, z) => rng.chance(0.3) || avoidCorridor(x, z));
    // river banks
    p.grove(rx - 68, -1800, rx - 44, 1600, 9, rng);
    p.grove(rx + 164, -1800, rx + 200, 1600, 10, rng);
    // gardens east of the outwork
    p.grove(-700, -2, -165, 200, 11, rng, () => rng.chance(0.25));
    // a few palms on the plaza beyond the gate
    for (const [x, z] of [
      [-22, -64],
      [-30, -84],
      [-40, -60],
      [15, -98],
    ])
      p.add(x, z, 1.05);
  }

  private buildGround(): void {
    const size = 14000;
    const g = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
    const tile = this.mats.ext.ground_sand?.tile[0] ?? 2;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * size) / tile, (uv.getY(i) * size) / tile);
    // cut the ground away over the moat and the river (the water lies lower)
    const M = LAYOUT.moat;
    const rx = LAYOUT.city.euphratesX;
    const mat = this.mats.ground;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev.call(mat, shader, r);
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `void main() {
  if ((vWPos.z > ${M.z0.toFixed(1)} && vWPos.z < ${M.z1.toFixed(1)} && abs(vWPos.x) > 7.0) || (vWPos.x > ${(rx - 40).toFixed(1)} && vWPos.x < ${(rx + 160).toFixed(1)})) discard;`,
      );
      // Outside the walls the plain is not bare sand: irrigated gardens and
      // stubble fields in large patches, dark damp soil along the moat and the
      // Euphrates, worn paths. Inside the city the ground stays dusty.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `{
          float outside = smoothstep(4.0, 30.0, vWPos.z) * smoothstep(18.0, 40.0, abs(vWPos.x)) + smoothstep(${(rx + 160).toFixed(1)}, ${(rx + 200).toFixed(1)}, vWPos.x);
          outside = clamp(outside, 0.0, 1.0);
          vec4 g1 = texture2D(uMacro, vWPos.xz * 0.0011);
          vec4 g2 = texture2D(uMacro, vWPos.xz * 0.0071 + 0.37);
          float field = smoothstep(0.5, 0.66, g1.r) * (0.55 + 0.45 * g2.g) * outside;
          float green = smoothstep(0.58, 0.75, g1.g) * outside;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.7, 0.66, 0.5), field * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.1, 0.045), green * 0.55);
          float dMoat = min(abs(vWPos.z - ${M.z0.toFixed(1)}), abs(vWPos.z - ${M.z1.toFixed(1)}));
          float damp = (1.0 - smoothstep(1.0, 16.0 + 10.0 * g2.b, dMoat)) * step(7.6, abs(vWPos.x));
          float dRiver = min(abs(vWPos.x - ${(rx - 40).toFixed(1)}), abs(vWPos.x - ${(rx + 160).toFixed(1)}));
          damp = max(damp, 1.0 - smoothstep(2.0, 28.0 + 16.0 * g2.b, dRiver));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.5, 0.52, 0.4), damp * 0.75);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.085, 0.035), damp * green * 0.4);
        }
        #include <roughnessmap_fragment>`,
      );
    };
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => prevKey() + '|groundCut';
    this.ground = new THREE.Mesh(g, mat);
    this.ground.position.y = -0.03;
    this.ground.receiveShadow = true;
    this.ground.name = 'ground';
    this.group.add(this.ground);
  }

  update(camera: THREE.PerspectiveCamera, dt = 0.016, time = 0): void {
    this.panels.update(camera);
    this.palms.update(camera);
    this.crowd.update(dt, time, camera);
  }
}
