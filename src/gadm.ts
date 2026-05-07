import { existsSync } from 'node:fs';
import { BoundingBox, GeoPackage, GeoPackageAPI } from '@ngageoint/geopackage';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';

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
  | {
      kind: 'mainland-us';
      feature: Feature<Polygon | MultiPolygon, GadmProperties>;
    }
  | {
      kind: 'accept';
      feature: Feature<Polygon | MultiPolygon, GadmProperties>;
    };

export interface GadmHandle {
  lookup(position: Position): LookupResult;
  close(): void;
}

type ParsedFeature = Feature<Polygon | MultiPolygon, GadmProperties>;

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
  if (!existsSync(resolved)) {
    throw new Error(
      `GADM geopackage not found at '${resolved}'. Set GADM_PATH or place the file at data/gadm.gpkg.`,
    );
  }
  let gp: Awaited<ReturnType<typeof GeoPackageAPI.open>>;
  try {
    gp = await GeoPackageAPI.open(resolved);
  } catch (cause) {
    throw new Error(
      `Could not open GADM geopackage at '${resolved}': file may be corrupt or unreadable.`,
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
  const cache = new Map<number, ParsedFeature | null>();

  // dao.fastQueryBoundingBox yields rows that dao.getRow accepts at runtime,
  // but @ngageoint/geopackage's types declare getRow's parameter as a flat
  // Record<string, DBValue> rather than the row wrapper. The runtime contract
  // is the load-bearing one; we cast through unknown at the boundary.
  type RowFromQuery = { values: Record<string, unknown> };

  function parseFeature(fid: number, row: RowFromQuery): ParsedFeature | null {
    const cached = cache.get(fid);
    if (cached !== undefined) return cached;

    const featureRow = dao.getRow(
      row as unknown as Parameters<typeof dao.getRow>[0],
    );
    const parsed = GeoPackage.parseFeatureRowIntoGeoJSON(featureRow, dao.srs);
    const geom = parsed.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
      cache.set(fid, null);
      return null;
    }
    const result: ParsedFeature = {
      type: 'Feature',
      geometry: geom as Polygon | MultiPolygon,
      properties: readProps(parsed.properties as Record<string, unknown>),
    };
    cache.set(fid, result);
    return result;
  }

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
        dao.fastQueryBoundingBox(bbox),
      ) as RowFromQuery[];
      if (candidates.length === 0) return { kind: 'ocean' };

      for (const row of candidates) {
        const fid = Number(row.values.fid);
        const feature = parseFeature(fid, row);
        if (!feature) continue;
        if (!booleanPointInPolygon(point, feature.geometry)) continue;
        if (feature.properties.gid_0 === 'USA') {
          return { kind: 'mainland-us', feature };
        }
        return { kind: 'accept', feature };
      }
      return { kind: 'ocean' };
    },
    close(): void {
      gp.close();
    },
  };
}
