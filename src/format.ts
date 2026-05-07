import type { Feature, FeatureCollection, Point, Position } from 'geojson';

export interface OutputProps {
  country: string;
  level1: string;
  gid0: string;
  gid1: string;
}

export function formatCoords(coords: Position): string {
  const [lon, lat] = coords;
  const latStr = `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(6)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

export function formatHuman(features: Feature<Point, OutputProps>[]): string {
  return features
    .map((f) => {
      const parts = [formatCoords(f.geometry.coordinates)];
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
