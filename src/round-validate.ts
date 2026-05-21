import { Instant } from '@js-joda/core';
import type { RoundFile } from './round-domain.ts';

const ROUND_FILE_RE = /^(\d{3,})\.geojson$/;

function parseRoundNumberFromPath(path: string): number | null {
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  const match = ROUND_FILE_RE.exec(base);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return n >= 1 ? n : null;
}

const VALID_MORPHIOR_STATUSES = new Set(['ok', 'noMatch', 'unavailable']);

export function validateRoundFile(data: unknown, path: string): RoundFile {
  function fail(msg: string): never {
    throw new Error(`round file ${path}: ${msg}`);
  }
  function validatePointGeometry(
    geom: unknown,
    where: string,
  ): asserts geom is { type: 'Point'; coordinates: [number, number] } {
    if (!geom || typeof geom !== 'object') {
      fail(`${where} geometry must be an object`);
    }
    const g = geom as Record<string, unknown>;
    if (g.type !== 'Point') {
      fail(
        `${where} geometry.type must be 'Point' (got ${JSON.stringify(g.type)})`,
      );
    }
    if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) {
      fail(`${where} geometry.coordinates must be a [lon, lat] array`);
    }
    const [lon, lat] = g.coordinates as unknown[];
    if (typeof lon !== 'number' || !Number.isFinite(lon)) {
      fail(`${where} geometry.coordinates[0] (lon) must be a finite number`);
    }
    if (typeof lat !== 'number' || !Number.isFinite(lat)) {
      fail(`${where} geometry.coordinates[1] (lat) must be a finite number`);
    }
  }
  if (!data || typeof data !== 'object') fail('not an object');
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'FeatureCollection') {
    fail("type must be 'FeatureCollection'");
  }
  const roundInfoRaw = obj.roundInfo;
  if (!roundInfoRaw || typeof roundInfoRaw !== 'object') {
    fail('roundInfo must be an object at the FeatureCollection top level');
  }
  const roundInfo = roundInfoRaw as Record<string, unknown>;
  const number = roundInfo.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    fail('roundInfo.number must be a positive integer');
  }
  const expectedRound = parseRoundNumberFromPath(path);
  if (expectedRound !== null && expectedRound !== number) {
    fail(
      `roundInfo.number (${number}) does not match filename (${expectedRound})`,
    );
  }
  if (!('endedAt' in roundInfo)) {
    fail('roundInfo must have an endedAt property (null or ISO 8601 string)');
  }
  const endedAt = roundInfo.endedAt;
  if (endedAt !== null && typeof endedAt !== 'string') {
    fail('roundInfo.endedAt must be null or an ISO 8601 string');
  }
  if (typeof endedAt === 'string') {
    try {
      Instant.parse(endedAt);
    } catch {
      fail('roundInfo.endedAt is not a valid ISO 8601 string');
    }
  }
  if (
    'language' in roundInfo &&
    roundInfo.language !== undefined &&
    typeof roundInfo.language !== 'string'
  ) {
    fail('roundInfo.language must be a string when present');
  }
  validateRoundInfoDnsChecks(roundInfo, endedAt !== null, fail);
  if (!Array.isArray(obj.features)) fail('features must be an array');
  const features = obj.features as unknown[];
  if (features.length === 0) {
    fail('features array is empty (target required at index 0)');
  }
  const target = features[0];
  if (!target || typeof target !== 'object') {
    fail('features[0] is not an object');
  }
  const targetObj = target as Record<string, unknown>;
  if (targetObj.id !== 'target') {
    fail(
      `features[0] must have id: "target" (got ${JSON.stringify(targetObj.id)})`,
    );
  }
  validatePointGeometry(targetObj.geometry, 'features[0]');
  const targetProps = targetObj.properties as
    | Record<string, unknown>
    | undefined;
  if (!targetProps || typeof targetProps !== 'object') {
    fail('features[0] (target) must have a properties object');
  }
  if (targetProps.player !== 'Target') {
    fail(
      `features[0] (target) must have properties.player === 'Target' (got ${JSON.stringify(targetProps.player)})`,
    );
  }
  if (!('distance' in targetProps) || targetProps.distance !== null) {
    fail('features[0] (target) must have properties.distance === null');
  }
  if (
    typeof targetProps.location !== 'string' ||
    targetProps.location.trim() === ''
  ) {
    fail(
      'features[0] (target) must have properties.location (non-empty string)',
    );
  }
  const isEnded = endedAt !== null;
  for (let i = 1; i < features.length; i++) {
    const sub = features[i];
    if (!sub || typeof sub !== 'object') {
      fail(`features[${i}] is not an object`);
    }
    if ((sub as { id?: unknown }).id === 'target') {
      fail(
        `features[${i}] must not have id: "target" — only features[0] may carry that id`,
      );
    }
    validatePointGeometry(
      (sub as { geometry?: unknown }).geometry,
      `features[${i}]`,
    );
    const subPropsRaw = (sub as { properties?: unknown }).properties;
    if (!subPropsRaw || typeof subPropsRaw !== 'object') {
      fail(`features[${i}] must have properties (object)`);
    }
    const subProps = subPropsRaw as Record<string, unknown>;
    if (typeof subProps.player !== 'string' || subProps.player.trim() === '') {
      fail(`features[${i}] must have properties.player (non-empty string)`);
    }
    if (
      typeof subProps.distance !== 'number' ||
      !Number.isFinite(subProps.distance)
    ) {
      fail(`features[${i}] must have properties.distance (finite number)`);
    }
    // `eliminated` is a closed-round property: present iff the round is ended.
    if (isEnded) {
      if (typeof subProps.eliminated !== 'boolean') {
        fail(
          `features[${i}] of an ended round must have properties.eliminated (boolean)`,
        );
      }
    } else if ('eliminated' in subProps) {
      fail(
        `features[${i}] is on an in-progress round and must not have properties.eliminated`,
      );
    }
  }
  return data as RoundFile;
}

function validateRoundInfoDnsChecks(
  roundInfo: Record<string, unknown>,
  isEnded: boolean,
  fail: (msg: string) => never,
): void {
  if (!isEnded) {
    if ('dnsChecks' in roundInfo) {
      fail(
        'roundInfo.dnsChecks must not be present on in-progress rounds (endedAt: null)',
      );
    }
    return;
  }
  if (!('dnsChecks' in roundInfo)) {
    fail('roundInfo.dnsChecks is required on ended rounds');
  }
  const checks = roundInfo.dnsChecks;
  if (!Array.isArray(checks)) {
    fail('roundInfo.dnsChecks must be an array');
  }
  checks.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      fail(`roundInfo.dnsChecks[${idx}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.player !== 'string' || e.player.trim() === '') {
      fail(`roundInfo.dnsChecks[${idx}].player must be a non-empty string`);
    }
    if (typeof e.couldHaveEscaped !== 'boolean') {
      fail(`roundInfo.dnsChecks[${idx}].couldHaveEscaped must be a boolean`);
    }
    const best = e.best;
    if (best !== null) {
      if (!best || typeof best !== 'object') {
        fail(`roundInfo.dnsChecks[${idx}].best must be an object or null`);
      }
      const bestObj = best as Record<string, unknown>;
      const point = bestObj.point;
      const distanceKm = bestObj.distanceKm;
      const pointOk =
        Array.isArray(point) &&
        point.length >= 2 &&
        typeof point[0] === 'number' &&
        Number.isFinite(point[0]) &&
        typeof point[1] === 'number' &&
        Number.isFinite(point[1]);
      if (!pointOk) {
        fail(
          `roundInfo.dnsChecks[${idx}].best.point must be a [lon, lat] array of finite numbers`,
        );
      }
      if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm)) {
        fail(
          `roundInfo.dnsChecks[${idx}].best.distanceKm must be a finite number`,
        );
      }
    }
    if (
      typeof e.morphiorDbStatus !== 'string' ||
      !VALID_MORPHIOR_STATUSES.has(e.morphiorDbStatus)
    ) {
      fail(
        `roundInfo.dnsChecks[${idx}].morphiorDbStatus must be one of ok | notFound | ambiguous | unavailable`,
      );
    }
    const count = e.morphiorDbSubmissionCount;
    const isOk = e.morphiorDbStatus === 'ok';
    if (isOk) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        fail(
          `roundInfo.dnsChecks[${idx}].morphiorDbSubmissionCount must be a non-negative integer when morphiorDbStatus === 'ok'`,
        );
      }
    } else if (count !== null) {
      fail(
        `roundInfo.dnsChecks[${idx}].morphiorDbSubmissionCount must be null when morphiorDbStatus !== 'ok'`,
      );
    }
  });
}
