import type { Position } from 'geojson';
import type { RandomSource } from './rng.ts';

const LAT_MIN_DEG = -60;
const LAT_MAX_DEG = 35;
const LON_MIN_DEG = -120;
const LON_MAX_DEG = -30;

const RAD_TO_DEG = 180 / Math.PI;

async function nextLatitude(rng: RandomSource): Promise<number> {
  for (;;) {
    const u = await rng.next();
    const y = 2 * u - 1;
    const latRad = Math.PI / 2 - Math.acos(y);
    const latDeg = latRad * RAD_TO_DEG;
    if (latDeg >= LAT_MIN_DEG && latDeg <= LAT_MAX_DEG) {
      return latDeg;
    }
  }
}

async function nextLongitude(rng: RandomSource): Promise<number> {
  const u = await rng.next();
  return LON_MIN_DEG + u * (LON_MAX_DEG - LON_MIN_DEG);
}

export async function samplePosition(rng: RandomSource): Promise<Position> {
  const lat = await nextLatitude(rng);
  const lon = await nextLongitude(rng);
  return [lon, lat];
}
