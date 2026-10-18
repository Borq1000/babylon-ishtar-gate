// Single source of truth for the dimensions and placement of the reconstruction.
// Units: metres. Frame: y up, north = +Z (the approach), south = -Z (the city),
// west = +X (South Palace, Euphrates), east = -X.
//
// Values follow excavation data (Koldewey) and modern reconstructions (Berlin
// Pergamon Museum; Pedersén 2021/2024) where known; disputed or unknown values
// are plausible artistic choices (marked "artistic").

export const C = 1 / 12; // brick course incl. hairline joint (≈8.3 cm)
export const L = 1 / 3; // brick length module (33 cm)

export const LAYOUT = {
  road: {
    halfWidth: 11, // street ≈ 20–24 m between the walls
    zStart: 0,
    zEnd: 180, // lion section: 180 m from the Ishtar Gate to the North Gate
    limeHalfWidth: 2.625, // 5 limestone slabs of 1.05 m across the centre
    brecciaHalfWidth: 5.265, // + 4 red-breccia slabs of 0.66 m each side
  },
  procWall: {
    thickness: 7,
    height: 11, // unknown (Berlin uses 12.5 m) — kept lower so the gate dominates (artistic)
    towerWidth: 9, // shallow towers on the street side, spaced by their own width
    towerProj: 0.5,
    towerHeight: 13.5,
    lionSpacingBricks: 9, // 60 lions per side, 3.0 m apart
    lionsPerSide: 60,
  },
  northGate: { z0: 180, z1: 210, halfWidth: 2.3, towerHeight: 16 },
  moat: { z0: 214, z1: 294 },
  frontGate: {
    zFront: 0,
    depth: 13,
    centreHalfWidth: 4.75,
    centreRecess: 1.6,
    centreHeight: 15.5,
    towerWidth: 6.25, // each tower spans x = ±[4.75, 11]
    towerHeight: 19,
    passageHalfWidth: 2.3, // 4.6 m passage
    archSpring: 8.6, // crown ≈ 10.9 m
  },
  court: { z0: -13, z1: -17, halfWidth: 6.5, wallHeight: 16 },
  rearGate: {
    zFront: -17,
    depth: 33,
    centreHalfWidth: 6,
    centreRecess: 2,
    centreHeight: 22,
    towerWidth: 8.5, // x = ±[6, 14.5]
    towerHeight: 26,
    passageHalfWidth: 2.3,
    archSpring: 9.5, // crown ≈ 11.8 m (Pedersén)
  },
  outerWall: { zNorth: -9.3, thickness: 3.7, height: 10, towerEvery: 19, towerProj: 3, towerWidth: 8, towerHeight: 13, extent: 430 },
  innerWall: { zNorth: -20.2, thickness: 6.5, height: 15, towerEvery: 19, towerProj: 4, towerWidth: 10, towerHeight: 19, extent: 480 },
  city: {
    zStart: -52,
    // Etemenanki: ≈0.8 km at bearing 190° from the gate; placed slightly closer (artistic)
    ziggurat: { x: 110, z: -640, base: 91.5, height: 91 },
    esagila: { x: 95, z: -790 },
    palace: { x0: 24, x1: 250, z0: -58, z1: -330 },
    ninmah: { x: -78, z: -84 },
    euphratesX: 380,
  },
  /** Start of the experience: on the Processional Way, eye height. */
  start: { x: -1.4, y: 1.7, z: 92, lookAt: [0, 9.5, 0] as [number, number, number] },
};

/** Brick-aligned helpers. */
export const snapCourse = (y: number, even = true): number => {
  const n = Math.round(y / C);
  return (even ? n - (n % 2) : n) * C;
};
export const snapBrick = (u: number): number => Math.round(u / L) * L;
