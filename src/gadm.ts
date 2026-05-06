import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { BoundingBox, GeoPackageAPI } from '@ngageoint/geopackage';

const TABLE_NAME = 'gadm_410';
const BBOX_EPSILON = 1e-6;
// In GADM 4.10, Puerto Rico and the U.S. Virgin Islands are their own
// country-level entities (GID_0 = 'PRI' and 'VIR'), not children of 'USA'.
// Rejecting GID_0 === 'USA' therefore accepts them automatically.

export interface GadmProperties {
  gid_0: string;
  name_0: string;
  gid_1: string;
  name_1: string;
}

export type LookupResult =
  | { kind: 'ocean' }
  | { kind: 'mainland-us' }
  | {
      kind: 'accept';
      feature: Feature<Polygon | MultiPolygon, GadmProperties>;
    };

export interface GadmHandle {
  lookup(position: Position): LookupResult;
  close(): void;
}

interface RawFeature {
  type: 'Feature';
  geometry?: Polygon | MultiPolygon | null;
  properties: Record<string, unknown>;
}

function resolvePath(explicit?: string): string {
  return explicit ?? process.env.GADM_PATH ?? 'data/gadm.gpkg';
}

function readProps(props: Record<string, unknown>): GadmProperties {
  return {
    gid_0: String(props.GID_0 ?? ''),
    name_0: String(props.NAME_0 ?? ''),
    gid_1: String(props.GID_1 ?? ''),
    name_1: String(props.NAME_1 ?? ''),
  };
}

export async function openGadm(path?: string): Promise<GadmHandle> {
  const resolved = resolvePath(path);
  let gp: Awaited<ReturnType<typeof GeoPackageAPI.open>>;
  try {
    gp = await GeoPackageAPI.open(resolved);
  } catch (cause) {
    throw new Error(
      `Could not open GADM geopackage at '${resolved}'. Set GADM_PATH or place the file at data/gadm.gpkg.`,
      { cause },
    );
  }
  if (!gp.getFeatureTables().includes(TABLE_NAME)) {
    gp.close();
    throw new Error(
      `GADM geopackage at '${resolved}' is missing the expected '${TABLE_NAME}' feature table.`,
    );
  }
  const dao = gp.getFeatureDao(TABLE_NAME);

  return {
    lookup(position: Position): LookupResult {
      const [lon, lat] = position;
      const bbox = new BoundingBox(
        lon - BBOX_EPSILON,
        lon + BBOX_EPSILON,
        lat - BBOX_EPSILON,
        lat + BBOX_EPSILON,
      );
      const point: Point = { type: 'Point', coordinates: [lon, lat] };
      const candidates = Array.from(
        dao.queryForGeoJSONIndexedFeaturesWithBoundingBox(bbox),
      ) as RawFeature[];
      for (const raw of candidates) {
        const geom = raw.geometry;
        if (!geom) continue;
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
        if (!booleanPointInPolygon(point, geom)) continue;
        const properties = readProps(raw.properties);
        if (properties.gid_0 === 'USA') {
          return { kind: 'mainland-us' };
        }
        return {
          kind: 'accept',
          feature: { type: 'Feature', geometry: geom, properties },
        };
      }
      return { kind: 'ocean' };
    },
    close(): void {
      gp.close();
    },
  };
}
