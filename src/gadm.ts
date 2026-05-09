import { existsSync } from 'node:fs';
import { BoundingBox, GeoPackage, GeoPackageAPI } from '@ngageoint/geopackage';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';

const TABLE_NAME = 'gadm_410';
const BBOX_EPSILON = 1e-6;
// In GADM 4.10, Puerto Rico and the U.S. Virgin Islands are their own
// country-level entities (GID_0 = 'PRI' and 'VIR'), not children of 'USA'.
// Rejecting GID_0 === 'USA' therefore accepts them automatically.

// Countries excluded from round selection. USA is excluded by design (the
// game is about the rest of the Americas). SGS (South Georgia and the
// South Sandwich Islands) is excluded because the game's southern limit
// is conceptually the Antarctic Convergence, which runs north of SGS.
export const REJECTED_GIDS: ReadonlySet<string> = new Set(['USA', 'SGS']);

export interface GadmProperties {
  gid_0: string;
  name_0: string;
  gid_1: string;
  name_1: string;
}

export type LookupResult =
  | { kind: 'ocean' }
  | {
      kind: 'rejected';
      feature: Feature<Polygon | MultiPolygon, GadmProperties>;
    }
  | {
      kind: 'accept';
      feature: Feature<Polygon | MultiPolygon, GadmProperties>;
    };

export interface BoundingBoxInput {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface CountryEntry {
  gid_0: string;
  name_0: string;
}

export interface GadmHandle {
  lookup(position: Position): LookupResult;
  /**
   * Unique `(GID_0, NAME_0)` pairs for countries with at least one feature
   * polygon that has a vertex inside `box`. Sorted by `name_0`. This filters
   * out fringe entries whose spatial-index bbox merely clips `box` (e.g.
   * antimeridian-wrap polygons) without any actual coordinate inside it.
   */
  candidateCountries(box: BoundingBoxInput): CountryEntry[];
  close(): void;
}

type ParsedFeature = Feature<Polygon | MultiPolygon, GadmProperties>;

// True if any polygon vertex lies inside `box`. Sufficient for the
// candidate-country filter: at the sampling-box scale, no level-1 admin
// unit can enclose the box without a vertex inside it.
function hasVertexInBox(
  geom: Polygon | MultiPolygon,
  box: BoundingBoxInput,
): boolean {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (
          lon >= box.minLon &&
          lon <= box.maxLon &&
          lat >= box.minLat &&
          lat <= box.maxLat
        ) {
          return true;
        }
      }
    }
  }
  return false;
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
        if (REJECTED_GIDS.has(feature.properties.gid_0)) {
          return { kind: 'rejected', feature };
        }
        return { kind: 'accept', feature };
      }
      return { kind: 'ocean' };
    },
    candidateCountries(box: BoundingBoxInput): CountryEntry[] {
      const bbox = new BoundingBox(
        box.minLon,
        box.maxLon,
        box.minLat,
        box.maxLat,
      );
      const accepted = new Map<string, string>();
      for (const row of dao.fastQueryBoundingBox(
        bbox,
      ) as Iterable<RowFromQuery>) {
        const gid_0 = String(row.values.GID_0 ?? '');
        if (!gid_0 || accepted.has(gid_0)) continue;
        const fid = Number(row.values.fid);
        const feature = parseFeature(fid, row);
        if (!feature) continue;
        if (!hasVertexInBox(feature.geometry, box)) continue;
        accepted.set(gid_0, feature.properties.name_0);
      }
      return Array.from(accepted, ([gid_0, name_0]) => ({
        gid_0,
        name_0,
      })).sort((a, b) => a.name_0.localeCompare(b.name_0));
    },
    close(): void {
      gp.close();
    },
  };
}

/**
 * Resolves a `[lon, lat]` to a human-readable region label
 * (e.g. "Río Negro, Argentina"), or `null` for ocean / unresolved points.
 * Used by `submit-round` and `end-round` to decorate output with location
 * names. Tests inject a stub implementation to avoid GADM I/O.
 */
export type LookupLocation = (position: Position) => string | null;

/**
 * Build a `LookupLocation` backed by an open `GadmHandle`. The caller
 * owns the handle's lifecycle (open in `main()`, `close()` in a `finally`).
 */
export function makeGadmLookupLocation(gadm: GadmHandle): LookupLocation {
  return (position) => {
    const result = gadm.lookup(position);
    if (result.kind === 'ocean') return null;
    return formatLocationFromProperties({
      name_0: result.feature.properties.name_0,
      name_1: result.feature.properties.name_1,
    });
  };
}

function formatLocationFromProperties(props: {
  name_0?: string | null;
  name_1?: string | null;
}): string | null {
  // Local copy of `formatLocation` semantics that doesn't depend on
  // round-domain — keeps gadm.ts free of round-domain imports.
  if (!props.name_0) return null;
  if (props.name_1) return `${props.name_1}, ${props.name_0}`;
  return props.name_0;
}
