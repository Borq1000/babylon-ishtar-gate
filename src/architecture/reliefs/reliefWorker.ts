/// <reference lib="webworker" />
// Generates relief maps off the main thread (OffscreenCanvas + Path2D).

import { generateRelief } from './ReliefGenerator';
import { reliefDef } from './ReliefCatalog';

self.onmessage = (e: MessageEvent<{ key: string; ppm: number }>) => {
  const { key, ppm } = e.data;
  const def = reliefDef(key);
  const maps = generateRelief(def, ppm);
  (self as unknown as Worker).postMessage({ key, maps }, [
    maps.heights.buffer,
    maps.albedo.buffer,
    maps.normal.buffer,
    maps.orm.buffer,
  ]);
};
