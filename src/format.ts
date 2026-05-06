import type { Feature, FeatureCollection, Point } from 'geojson';

export interface OutputProps {
  country: string;
  level1: string;
  gid0: string;
  gid1: string;
}

export function formatHuman(features: Feature<Point, OutputProps>[]): string {
  return features
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const latStr = `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}`;
      const lonStr = `${Math.abs(lon).toFixed(6)}°${lon >= 0 ? 'E' : 'W'}`;
      const parts = [`${latStr} ${lonStr}`];
      if (f.properties.level1) parts.push(f.properties.level1);
      parts.push(f.properties.country);
      return parts.join(', ');
    })
    .join('\n');
}

export function formatGeoJson(features: Feature<Point, OutputProps>[]): string {
  const collection: FeatureCollection<Point, OutputProps> = {
    type: 'FeatureCollection',
    features,
  };
  return JSON.stringify(collection, null, 2);
}
