import type { Position } from 'geojson';
import type { RandomSource } from './rng.ts';

export const SAMPLING_BBOX = {
  minLon: -120,
  minLat: -60,
  maxLon: -30,
  maxLat: 35,
} as const;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// acos input bounds chosen so (π/2) - acos(y) lands directly in [minLat, maxLat]:
// y = sin(lat), so y ∈ [sin(minLat), sin(maxLat)] gives latitudes uniform on
// the sphere's surface area within the band — no rejection needed.
const Y_MIN = Math.sin(SAMPLING_BBOX.minLat * DEG_TO_RAD);
const Y_MAX = Math.sin(SAMPLING_BBOX.maxLat * DEG_TO_RAD);

async function nextLatitude(rng: RandomSource): Promise<number> {
  const u = await rng.next();
  const y = Y_MIN + u * (Y_MAX - Y_MIN);
  return (Math.PI / 2 - Math.acos(y)) * RAD_TO_DEG;
}

async function nextLongitude(rng: RandomSource): Promise<number> {
  const u = await rng.next();
  return (
    SAMPLING_BBOX.minLon + u * (SAMPLING_BBOX.maxLon - SAMPLING_BBOX.minLon)
  );
}

export async function samplePosition(rng: RandomSource): Promise<Position> {
  const lat = await nextLatitude(rng);
  const lon = await nextLongitude(rng);
  return [lon, lat];
}
