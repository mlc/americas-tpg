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
      return [
        `Latitude:    ${lat.toFixed(6)}`,
        `Longitude:   ${lon.toFixed(6)}`,
        `Country:     ${f.properties.country}`,
        `Subdivision: ${f.properties.level1}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function formatGeoJson(features: Feature<Point, OutputProps>[]): string {
  const collection: FeatureCollection<Point, OutputProps> = {
    type: 'FeatureCollection',
    features,
  };
  return JSON.stringify(collection, null, 2);
}
