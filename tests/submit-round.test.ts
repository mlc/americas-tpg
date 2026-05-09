import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Position } from 'geojson';
import type {
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import {
  defaultComputeDistance,
  type LookupLocation,
  parseCoordArgs,
  submitRound,
} from '../src/submit-round.ts';
import { withEliminated } from './test-helpers.ts';

function makeArgentinaTarget(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: { location: 'Río Negro, Argentina' },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tpg-submit-round-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRound(
  round: number,
  endedAt: string | null,
  submissions: SubmissionFeature[] = [],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number: round, endedAt },
    features: [makeArgentinaTarget(), ...submissions],
  };
}

function makeSubmission(
  player: string,
  distance: number,
  location?: string,
): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
      player,
      distance,
      ...(location ? { location } : {}),
    },
  };
}

function constantDistance(km: number) {
  return (_target: Position, _submission: Position) => km;
}

function constantLocation(value: string | null): LookupLocation {
  return () => value;
}

describe('submitRound — round 1 open enrollment (R6 / AE1 setup)', () => {
  test('any player accepted; submission appended', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: 'alice',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      lookupLocation: constantLocation('Río Negro, Argentina'),
      computeDistance: constantDistance(11.123),
    });
    assert.equal(result.round, 1);
    assert.equal(result.player, 'alice');
    assert.equal(result.distance, 11.123);
    assert.equal(result.location, 'Río Negro, Argentina');
    assert.equal(result.replaced, false);
    assert.equal(result.file.features.length, 2);
  });

  test('player name is trimmed', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: '  alice  ',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(10),
    });
    assert.equal(result.player, 'alice');
  });
});

describe('submitRound — eligibility (R7 / AE3)', () => {
  test('round-1 last-place rejected when submitting in round 2', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30), // last
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    await assert.rejects(
      submitRound({
        player: 'dan',
        lat: -42.6,
        lng: -67.5,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /not eligible for round 2/,
    );
  });

  test('round-1 non-submitter rejected in round 2', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [makeSubmission('alice', 10), makeSubmission('bob', 20)],
        ['bob'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    await assert.rejects(
      submitRound({
        player: 'newcomer',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /not eligible for round 2.*Eligible: alice/,
    );
  });

  test('round-1 surviving player accepted in round 2', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30),
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    const result = await submitRound({
      player: 'alice',
      lat: 0,
      lng: 0,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(15),
    });
    assert.equal(result.round, 2);
    assert.equal(result.player, 'alice');
  });

  test('--force admits an otherwise-ineligible player', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30), // last → normally eliminated
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    const result = await submitRound({
      player: 'dan',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      force: true,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(10),
    });
    assert.equal(result.round, 2);
    assert.equal(result.player, 'dan');
    assert.equal(result.distance, 10);
  });

  test('eligibility trusts persisted `eliminated` field, not recomputed distances', async () => {
    // dan is the actual farthest (distance 30), but we persist alice as the
    // eliminated player. The eligibility check must trust the file: alice
    // should be rejected, dan should be accepted.
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30),
        ],
        ['alice'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /not eligible for round 2/,
    );

    const result = await submitRound({
      player: 'dan',
      lat: 0,
      lng: 0,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(10),
    });
    assert.equal(result.player, 'dan');
  });

  test('--force does not override an ended round', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, '2026-05-06T12:00:00Z'),
    );

    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        explicitRound: 1,
        force: true,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /round 1 is ended; submissions are closed/,
    );
  });
});

describe('submitRound — append vs replace (R9 / AE7)', () => {
  test('second submission for same player replaces, not appends', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));

    await submitRound({
      player: 'alice',
      lat: 12.0,
      lng: -45.0,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(100),
    });
    const second = await submitRound({
      player: 'alice',
      lat: 13.0,
      lng: -46.0,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(50),
    });

    assert.equal(second.replaced, true);
    assert.equal(second.distance, 50);
    assert.equal(second.file.features.length, 2);
    const subs = (second.file.features.slice(1) as SubmissionFeature[]).filter(
      (f) => f.properties.player === 'alice',
    );
    assert.equal(subs.length, 1);
    assert.equal(subs[0].properties.distance, 50);
  });
});

describe('submitRound — location decoration (R10)', () => {
  test('location property present when GADM resolves', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: 'alice',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      lookupLocation: constantLocation('Río Negro, Argentina'),
      computeDistance: constantDistance(10),
    });
    assert.equal(result.location, 'Río Negro, Argentina');
    const sub = result.file.features[1] as SubmissionFeature;
    assert.equal(sub.properties.location, 'Río Negro, Argentina');
  });

  test('mainland-US submission yields location', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: 'alice',
      lat: 36.7,
      lng: -119.4,
      roundsDir: dir,
      lookupLocation: constantLocation('California, United States'),
      computeDistance: constantDistance(10000),
    });
    assert.equal(result.location, 'California, United States');
  });

  test('ocean submission omits location', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: 'alice',
      lat: 0,
      lng: -30,
      roundsDir: dir,
      lookupLocation: constantLocation(null),
      computeDistance: constantDistance(5000),
    });
    assert.equal(result.location, undefined);
    const sub = result.file.features[1] as SubmissionFeature;
    assert.equal('location' in sub.properties, false);
  });
});

describe('submitRound — error paths (R11)', () => {
  test('round already ended → rejected', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, '2026-05-06T12:00:00Z'),
    );
    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        explicitRound: 1,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /round 1 is ended/,
    );
  });

  test('no active round at all → rejected', async () => {
    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /no active round/,
    );
  });

  test('invalid latitude → clear error', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 91,
        lng: 0,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /invalid latitude/,
    );
  });

  test('invalid longitude → clear error', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    await assert.rejects(
      submitRound({
        player: 'alice',
        lat: 0,
        lng: 181,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /invalid longitude/,
    );
  });

  test('empty player name → rejected', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    await assert.rejects(
      submitRound({
        player: '   ',
        lat: 0,
        lng: 0,
        roundsDir: dir,
        lookupLocation: constantLocation(null),
        computeDistance: constantDistance(10),
      }),
      /player name is required/,
    );
  });
});

describe('defaultComputeDistance — real @turf/distance wiring', () => {
  test('1° longitude at equator ≈ 111.195 km (coordinate-order smoke test)', () => {
    // distance from (0°N, 0°E) to (0°N, 1°E) on a sphere is about 111.195 km
    // via Haversine. This pins coordinate order ([lon, lat]) and units (km).
    const km = defaultComputeDistance([0, 0], [1, 0]);
    assert.ok(Math.abs(km - 111.195) < 0.05, `expected ~111.195 km, got ${km}`);
  });

  test('1° latitude at meridian ≈ 111.195 km', () => {
    const km = defaultComputeDistance([0, 0], [0, 1]);
    assert.ok(Math.abs(km - 111.195) < 0.05, `expected ~111.195 km, got ${km}`);
  });
});

describe('submitRound — atomic write', () => {
  test('written file matches in-memory result', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    const result = await submitRound({
      player: 'alice',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      lookupLocation: constantLocation('Río Negro, Argentina'),
      computeDistance: constantDistance(11.123),
    });
    const onDisk = JSON.parse(await readFile(result.path, 'utf8'));
    assert.equal(onDisk.features.length, 2);
    assert.equal(onDisk.features[1].properties.player, 'alice');
    assert.equal(onDisk.features[1].properties.distance, 11.123);
  });
});

describe('parseCoordArgs — CLI coord argument joining', () => {
  test('two positionals are joined with a space (decimal lat/lng)', () => {
    const [lng, lat] = parseCoordArgs(['40.7128', '-74.0060']);
    assert.equal(lng, -74.006);
    assert.equal(lat, 40.7128);
  });

  test('single quoted positional with comma works', () => {
    const [lng, lat] = parseCoordArgs(['40.7128, -74.0060']);
    assert.equal(lng, -74.006);
    assert.equal(lat, 40.7128);
  });

  test('NESW-suffixed positionals join correctly', () => {
    const [lng, lat] = parseCoordArgs(['40.7128°N', '74.0060°W']);
    assert.equal(lng, -74.006);
    assert.equal(lat, 40.7128);
  });

  test('DMS form parses', () => {
    const [lng, lat] = parseCoordArgs(['40:42:46N', '74:00:21W']);
    assert.ok(Math.abs(lat - (40 + 42 / 60 + 46 / 3600)) < 1e-9);
    assert.ok(Math.abs(lng - -(74 + 0 / 60 + 21 / 3600)) < 1e-9);
  });

  test('empty array → "expected at least one" error', () => {
    assert.throws(() => parseCoordArgs([]), /expected at least one/);
  });

  test('un-decodable input → error includes the joined raw text', () => {
    assert.throws(
      () => parseCoordArgs(['40.5']),
      /Invalid coordinate '40\.5':/,
    );
  });

  test('out-of-range latitude → error includes the underlying DMS message', () => {
    assert.throws(
      () => parseCoordArgs(['91', '0']),
      /Invalid coordinate '91 0': .*Latitude .* not in/,
    );
  });
});
