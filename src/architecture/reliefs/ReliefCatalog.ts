// The relief panels used in the world, by key. Shared by the main thread and workers.

import type { AnimalDef } from './ReliefTypes';
import { GLAZE, makeBull, makeDragon, makeLion } from './AnimalShapes';

export const RELIEF_KEYS = ['lionA', 'lionB', 'bull', 'dragon'] as const;
export type ReliefKey = (typeof RELIEF_KEYS)[number];

export function reliefDef(key: string): AnimalDef {
  switch (key) {
    case 'lionA': {
      // white lion with an ochre mane, on the turquoise register of the Processional Way
      const d = makeLion(GLAZE.white, GLAZE.ochre);
      d.bottomBand = undefined;
      return d;
    }
    case 'lionB': {
      // yellow lion with a red-brown mane (the second colour scheme of the frieze)
      const d = makeLion(GLAZE.gold, GLAZE.brown);
      d.bottomBand = undefined;
      return d;
    }
    case 'bull':
      return makeBull();
    case 'dragon':
      return makeDragon();
    default:
      throw new Error(`unknown relief ${key}`);
  }
}
