import DMS from 'geographiclib-dms';
import type { Point } from 'geojson';

export const decodeCoord = (coords: string): Point => {
  const s = coords.trim().replace(/ +([NESW])/giu, (_, x) => x);
  let components: string[];
  if (/\S\s+\S/.test(s)) {
    // Whitespace separates the two coords; absorb any adjacent comma so
    // "40,7128, -74,0060" (European decimal + comma+space separator) splits
    // the same way as "40.7128, -74.0060".
    components = s.split(/\s*,?\s+,?\s*/).filter((c) => c.length > 0);
  } else if (s.includes(',')) {
    // No whitespace, only commas: either "X,Y" (one separator comma) or
    // "X,XXX,Y,YYY" (two European decimals + one separator comma).
    const parts = s.split(',');
    components =
      parts.length === 4
        ? [`${parts[0]},${parts[1]}`, `${parts[2]},${parts[3]}`]
        : parts;
  } else {
    components = [s];
  }
  if (components.length !== 2) {
    throw new Error(`unable to parse ${coords}`);
  }
  const normalized = components.map((c) => c.replace(',', '.')) as [
    string,
    string,
  ];
  const { lat, lon } = DMS.DecodeLatLon(...normalized);
  return {
    type: 'Point',
    coordinates: [lon, lat],
  };
};
