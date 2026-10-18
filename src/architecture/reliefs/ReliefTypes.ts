// Data model for moulded-brick relief panels (lions, bulls, mušḫuššu dragons).

export type Pt = [number, number];

export type PatternKind = 'none' | 'locks' | 'scales' | 'curls' | 'hair';

export interface ReliefLayer {
  id: string;
  /** Closed outlines (smooth Catmull-Rom through the points), def units. */
  shapes?: Pt[][];
  /** Closed outlines drawn with straight segments (sharp features: teeth, claws). */
  polys?: Pt[][];
  /** Open thick strokes: [points, width in def units]. */
  strokes?: { pts: Pt[]; width: number; taper?: number }[];
  /** Ellipses: cx, cy, rx, ry, rotation(rad). */
  ellipses?: [number, number, number, number, number][];
  /** sRGB hex glaze colour; omit to keep the colour below (sculpt-only layer). */
  color?: number;
  /** Height above the brick face at the layer edge (m). */
  base: number;
  /** Additional rounded height towards the inside (m). */
  dome: number;
  /** Distance over which the dome rises (m). */
  bevel: number;
  /** Large-scale volume: extra height reached at volumeDist from the edge. */
  volume?: number;
  volumeDist?: number;
  /** Carve instead of raise (eyes, mouth lines, nostrils). */
  incise?: boolean;
  /** Draw a thin dark glaze-separation line along the boundary. */
  outline?: boolean;
  /** Height combine mode: 'max' (default) or 'add' (sits on whatever is below). */
  mode?: 'max' | 'add';
  pattern?: PatternKind;
  patternColor?: number;
  /** Pattern orientation: radial around a centre, or a fixed direction (deg, 0 = +x). */
  flowCenter?: Pt;
  flowAngle?: number;
  patternScale?: number;
}

export interface AnimalDef {
  name: string;
  /** Def-space frame the shapes were authored in (x right, y down). */
  frame: { w: number; h: number };
  /** Panel size in bricks (columns of L = 1/3 m) and courses (C = 0.1 m). */
  cols: number;
  rows: number;
  /** Where the def frame lands inside the panel, in metres: x, y (from panel top-left), scale (m per def unit). */
  place: { x: number; y: number; s: number };
  layers: ReliefLayer[];
  /** Background glaze palette (sRGB): common A, common B, light C, dark D, rare grey-teal E. */
  background: [number, number, number, number, number];
  /** Optional coloured courses at the bottom (e.g. the yellow base course of the lion frieze). */
  bottomBand?: { rows: number; color: number };
}

export interface ReliefMaps {
  width: number;
  height: number;
  /** Height in metres, row 0 = top of panel. */
  heights: Float32Array;
  albedo: Uint8Array; // RGBA, row 0 = bottom (texture order)
  normal: Uint8Array; // RGBA
  orm: Uint8Array; // RGBA (ao, rough, metal, height01)
  panelW: number;
  panelH: number;
  heightMax: number;
}
