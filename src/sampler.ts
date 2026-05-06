import type { Position } from 'geojson';
import type { RandomSource } from './rng.ts';

const LAT_MIN_DEG = -60;
const LAT_MAX_DEG = 35;
const LON_MIN_DEG = -120;
const LON_MAX_DEG = -30;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// acos input bounds chosen so (π/2) - acos(y) lands directly in [LAT_MIN, LAT_MAX]:
// y = sin(lat), so y ∈ [sin(LAT_MIN), sin(LAT_MAX)] gives latitudes uniform on
// the sphere's surface area within the band — no rejection needed.
const Y_MIN = Math.sin(LAT_MIN_DEG * DEG_TO_RAD);
const Y_MAX = Math.sin(LAT_MAX_DEG * DEG_TO_RAD);

async function nextLatitude(rng: RandomSource): Promise<number> {
  const u = await rng.next();
  const y = Y_MIN + u * (Y_MAX - Y_MIN);
  return (Math.PI / 2 - Math.acos(y)) * RAD_TO_DEG;
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
