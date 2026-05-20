import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Instant } from '@js-joda/core';
import type { Position } from 'geojson';
import { createRound } from '../src/create-round.ts';
import { endRound } from '../src/end-round.ts';
import { type MorphiorClient, MorphiorDbError } from '../src/morphiordb.ts';
import type {
  DnsCheck,
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import { submitRound } from '../src/submit-round.ts';
import { withEliminated } from './test-helpers.ts';

const ARGENTINA_TARGET_COORDS: [number, number] = [-67.5, -42.5];

function makeArgentinaTarget(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: ARGENTINA_TARGET_COORDS },
    properties: {
      player: 'Target',
      distance: null,
      location: 'Río Negro, Argentina',
    },
  };
}

const argentinaTarget = makeArgentinaTarget();

/**
 * Stub MorphiorDB client returning empty data — keeps tests offline. Tests
 * that need specific MorphiorDB behavior pass their own client.
 */
function emptyMorphior(): MorphiorClient {
  return {
    findPlayers: async () => [],
    fetchSubmissions: async () => [],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tpg-end-round-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Build a submission feature. The geometry coord defaults to the round's
 * target — this keeps DNS players' historical bestDistance ≈ 0 km so the
 * honest-DNS save rule does not fire in tests that aren't testing it. Tests
 * that exercise the rule pass `coords` explicitly.
 */
function makeSubmission(
  player: string,
  distance: number,
  coords: Position = ARGENTINA_TARGET_COORDS,
): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: { player, distance },
  };
}

function makeRound(
  round: number,
  endedAt: string | null,
  submissions: SubmissionFeature[] = [],
  dnsChecks: DnsCheck[] = [],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: {
      number: round,
      endedAt,
      ...(endedAt !== null ? { dnsChecks } : {}),
    },
    features: [makeArgentinaTarget(), ...submissions],
  };
}

const fixedNow = () => Instant.parse('2026-05-07T00:00:00Z');

describe('endRound — AE1 (round 1, no DNS)', () => {
  test('eliminates only the farthest; round 2 eligibility = 2 non-last', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 12.345),
        makeSubmission('bob', 45.678),
        makeSubmission('carol', 89.012),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.eliminations], ['carol']);
    assert.deepEqual([...result.dnsSet], []);
    assert.deepEqual([...result.nextEligible].sort(), ['alice', 'bob']);
    assert.match(result.output, /Standings:/);
    assert.match(result.output, /carol \(last place\)/);
    assert.match(result.output, /Round 2 starts with: alice, bob/);
    assert.equal(result.endedAt, '2026-05-07T00:00:00Z');
    assert.equal(result.wasAlreadyEnded, false);
  });
});

describe('endRound — AE2 (round 2 with one DNS)', () => {
  test('eliminates farther of submitters + carol (DNS)', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 10),
            makeSubmission('bob', 20),
            makeSubmission('carol', 30),
            makeSubmission('dan', 100),
          ],
          ['dan'],
        ),
      ),
    );
    // Round 1 eligible-for-next = {alice, bob, carol}. dan was last.
    // Round 2: alice and bob submit; carol does not.
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.eliminations], ['bob']);
    assert.deepEqual([...result.dnsSet], ['carol']);
    assert.deepEqual([...result.nextEligible], ['alice']);
    assert.match(result.output, /carol \(did not submit\)/);
    assert.match(result.output, /bob \(last place\)/);
    assert.match(result.output, /Game over\. Winner: alice/);
  });
});

describe('endRound — AE4 (25 m tie)', () => {
  test('100.000 km vs 100.020 km → both eliminated as tied', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 50),
        makeSubmission('bob', 100.0),
        makeSubmission('carol', 100.02),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.eliminations].sort(), ['bob', 'carol']);
    assert.deepEqual([...result.nextEligible], ['alice']);
    assert.match(result.output, /bob, carol \(tied for last, within 25 m\)/);
    assert.match(result.output, /Game over\. Winner: alice/);
  });
});

describe('endRound — AE5 (winner declaration)', () => {
  test('exactly one player remains eligible → winner banner', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.nextEligible], ['alice']);
    assert.match(result.output, /Game over\. Winner: alice/);
  });
});

describe('endRound — AE6 (stalemate cases)', () => {
  test('everyone tied within 25 m → stalemate', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 100.0),
        makeSubmission('bob', 100.01),
        makeSubmission('carol', 100.02),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.equal(result.nextEligible.size, 0);
    assert.match(result.output, /Game over: stalemate/);
  });

  test('round N>=2 with sole submitter who is also "last" → stalemate', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
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
      ),
    );
    // Round 1 eligible-for-next = {alice, bob}. dan last.
    // Round 2: only alice submits.
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 50)]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    // alice is the only submitter, so she's "farthest" by tautology and
    // gets eliminated. bob is DNS. Both gone → stalemate.
    assert.deepEqual([...result.eliminations], ['alice']);
    assert.deepEqual([...result.dnsSet], ['bob']);
    assert.equal(result.nextEligible.size, 0);
    assert.match(result.output, /Game over: stalemate/);
  });
});

describe('endRound — R16 idempotent re-end', () => {
  test('re-running on an already-ended round prints same output; endedAt unchanged', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
        makeSubmission('carol', 30),
      ]),
    );

    const first = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    assert.equal(first.wasAlreadyEnded, false);
    assert.equal(first.endedAt, '2026-05-07T00:00:00Z');

    // Re-run with explicit --round 1 (default findActiveRound would skip ended)
    const second = await endRound({
      roundsDir: dir,
      explicitRound: 1,
      now: () => Instant.parse('2026-05-07T01:00:00Z'), // different time
      morphiorClient: emptyMorphior(),
    });

    assert.equal(second.wasAlreadyEnded, true);
    // endedAt unchanged from first run despite different "now"
    assert.equal(second.endedAt, '2026-05-07T00:00:00Z');
    // Output is identical
    assert.equal(second.output, first.output);

    // On-disk file's endedAt is still the original
    const onDisk = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(onDisk.roundInfo.endedAt, '2026-05-07T00:00:00Z');
  });
});

describe('endRound — persistence (R14)', () => {
  test('endedAt is set to a parseable ISO 8601 string after first run', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
      ]),
    );

    await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    const onDisk = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));
    const onDiskEndedAt = onDisk.roundInfo.endedAt;
    assert.equal(typeof onDiskEndedAt, 'string');
    assert.doesNotThrow(() => Instant.parse(onDiskEndedAt));
  });

  test('writes eliminated: true/false on every submission', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
        makeSubmission('carol', 30),
      ]),
    );

    await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    const onDisk = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));
    const byPlayer = new Map<string, boolean>(
      onDisk.features
        .slice(1)
        .map((f: { properties: { player: string; eliminated: boolean } }) => [
          f.properties.player,
          f.properties.eliminated,
        ]),
    );
    assert.equal(byPlayer.get('alice'), false);
    assert.equal(byPlayer.get('bob'), false);
    assert.equal(byPlayer.get('carol'), true);
  });

  test('re-end on an already-ended round preserves eliminated booleans', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
        makeSubmission('carol', 30),
      ]),
    );
    await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    const first = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));

    await endRound({
      roundsDir: dir,
      explicitRound: 1,
      now: () => Instant.parse('2026-05-07T01:00:00Z'),
      morphiorClient: emptyMorphior(),
    });
    const second = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));

    type Sub = { properties: { player: string; eliminated: boolean } };
    const flagsOf = (parsed: { features: Sub[] }) =>
      parsed.features
        .slice(1)
        .map((f) => `${f.properties.player}=${f.properties.eliminated}`)
        .sort();
    assert.deepEqual(flagsOf(second), flagsOf(first));
  });
});

describe('endRound — error paths', () => {
  test('no active round → rejected', async () => {
    await assert.rejects(
      endRound({ roundsDir: dir }),
      /no active round to end/,
    );
  });

  test('explicit --round to non-existent file → rejected', async () => {
    await assert.rejects(
      endRound({ roundsDir: dir, explicitRound: 99 }),
      /round file not found/,
    );
  });
});

describe('endRound — integration with create + submit', () => {
  test('AE1 end-to-end: createRound (stub) → 3 submissions → endRound', async () => {
    await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });

    const constLookup = () => 'Río Negro, Argentina';
    let dist = 10;
    const constDist = () => {
      const v = dist;
      dist += 10;
      return v;
    };
    await submitRound({
      player: 'alice',
      lat: -42.6,
      lng: -67.5,
      roundsDir: dir,
      lookupLocation: constLookup,
      computeDistance: constDist,
    });
    await submitRound({
      player: 'bob',
      lat: -42.7,
      lng: -67.4,
      roundsDir: dir,
      lookupLocation: constLookup,
      computeDistance: constDist,
    });
    await submitRound({
      player: 'carol',
      lat: -42.8,
      lng: -67.3,
      roundsDir: dir,
      lookupLocation: constLookup,
      computeDistance: constDist,
    });

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    assert.deepEqual([...result.eliminations], ['carol']);
    assert.deepEqual([...result.nextEligible].sort(), ['alice', 'bob']);
    assert.match(result.output, /Round 2 starts with: alice, bob/);
  });
});

describe('endRound — honest-DNS save rule', () => {
  // Coords far from the Argentina target (Río Negro): roughly Pacific/null-island.
  // ~8500 km from target, well beyond any reasonable currentMax.
  const FAR_FROM_TARGET: [number, number] = [0, 0];

  test('one DNS, history close to target → couldHaveEscaped:true (sore loser), no save fires', async () => {
    // Carol's round 1 submission is at the target (default coord), so her
    // bestDistance is ~0 km. With currentMaxKm = 50, she could have escaped
    // → not honest → no save → standard rules apply.
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 10),
            makeSubmission('bob', 20),
            makeSubmission('carol', 30), // default coord = target
            makeSubmission('dan', 100),
          ],
          ['dan'],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.eliminations], ['bob']);
    assert.equal(result.savedSet.size, 0);
    assert.equal(result.dnsChecks.length, 1);
    assert.equal(result.dnsChecks[0].player, 'carol');
    assert.equal(result.dnsChecks[0].couldHaveEscaped, true);
    assert.equal(result.dnsChecks[0].morphiorDbStatus, 'unavailable');
    assert.equal(result.dnsChecks[0].morphiorDbSubmissionCount, null);
    // best.point exists because carol has local history (her round 1 submission).
    assert.deepEqual(result.dnsChecks[0].best?.point, ARGENTINA_TARGET_COORDS);
  });

  test('one DNS, far-from-target history → couldHaveEscaped:false (honest), save fires for last-place submitter', async () => {
    // Dan DNS'd round 2; his round 1 submission was placed at FAR_FROM_TARGET
    // (~8500 km from today's target). With currentMax = 50, his bestDistance
    // exceeds the cutoff → honest DNS → save fires for the actual last-place.
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    // Save fires: bob spared, dan eliminated as DNS.
    assert.deepEqual([...result.eliminations], []);
    assert.deepEqual([...result.savedSet].sort(), ['bob']);
    assert.deepEqual([...result.nextEligible].sort(), ['alice', 'bob']);
    assert.equal(result.dnsChecks.length, 1);
    assert.equal(result.dnsChecks[0].player, 'dan');
    assert.equal(result.dnsChecks[0].couldHaveEscaped, false);
    assert.ok(result.dnsChecks[0].best !== null);
    assert.ok(result.dnsChecks[0].best.distanceKm > 50);
  });

  test('eliminated flag on disk reflects post-rule state (saved player is false)', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    const onDisk = JSON.parse(await readFile(result.path, 'utf8'));
    const subs = onDisk.features.slice(1) as Array<{
      properties: { player: string; eliminated: boolean };
    }>;
    const flags = new Map(
      subs.map((s) => [s.properties.player, s.properties.eliminated]),
    );
    assert.equal(flags.get('alice'), false);
    assert.equal(flags.get('bob'), false, 'bob saved by honest-DNS rule');
  });

  test('persists dnsChecks on roundInfo with full schema', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 5)]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    const onDisk = JSON.parse(await readFile(result.path, 'utf8'));
    assert.ok(Array.isArray(onDisk.roundInfo.dnsChecks));
    assert.equal(onDisk.roundInfo.dnsChecks.length, 1);
    const check = onDisk.roundInfo.dnsChecks[0];
    assert.equal(check.player, 'dan');
    assert.equal(check.couldHaveEscaped, false);
    assert.deepEqual(check.best.point, FAR_FROM_TARGET);
    assert.equal(typeof check.best.distanceKm, 'number');
    assert.equal(check.morphiorDbStatus, 'unavailable');
    assert.equal(check.morphiorDbSubmissionCount, null);
  });

  test('zero-DNS round: dnsChecks empty array, behavior unchanged', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 20),
        makeSubmission('carol', 100),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    assert.deepEqual(result.dnsChecks, []);
    assert.equal(result.savedSet.size, 0);
    assert.deepEqual([...result.eliminations], ['carol']);
  });

  test('multiple DNS, one honest + one sore loser → save fires once', async () => {
    // Carol DNS'd round 2; her round 1 submission was AT the target (close).
    // → couldHaveEscaped: true (sore loser).
    // Dan DNS'd round 2; his round 1 submission was FAR_FROM_TARGET.
    // → couldHaveEscaped: false (honest). One honest DNS triggers save.
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('carol', 30), // default coord = target → close history
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.deepEqual([...result.savedSet].sort(), ['bob']);
    assert.equal(result.dnsChecks.length, 2);
    const byPlayer = new Map(result.dnsChecks.map((c) => [c.player, c]));
    assert.equal(byPlayer.get('carol')?.couldHaveEscaped, true);
    assert.equal(byPlayer.get('dan')?.couldHaveEscaped, false);
  });

  test('MorphiorDB unavailable → status:unavailable; round closes with local-only history', async () => {
    const failingMorphior: MorphiorClient = {
      findPlayers: async () => {
        throw new MorphiorDbError('transport', 'boom');
      },
      fetchSubmissions: async () => [],
    };

    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: failingMorphior,
    });
    assert.equal(result.dnsChecks[0].morphiorDbStatus, 'unavailable');
    // Round still closes; rule still evaluates from local history.
    assert.equal(result.endedAt, '2026-05-07T00:00:00Z');
    assert.equal(result.dnsChecks[0].couldHaveEscaped, false);
  });

  test('MorphiorDB returns ambiguous match → status:noMatch; falls back to local history', {
    skip: 'MorphiorDB API disabled — re-enable when client lookups are restored',
  }, async () => {
    const ambiguous: MorphiorClient = {
      findPlayers: async () => [
        {
          discord_id: '1',
          canonical_name: 'dan',
          name: 'Dan',
          aliases: ['dan'],
        },
        {
          discord_id: '2',
          canonical_name: 'dan2',
          name: 'Dan',
          aliases: ['dan'],
        },
      ],
      fetchSubmissions: async () => [],
    };
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: ambiguous,
    });
    assert.equal(result.dnsChecks[0].morphiorDbStatus, 'noMatch');
    assert.equal(result.dnsChecks[0].morphiorDbSubmissionCount, null);
  });

  test('MorphiorDB ok happy path: returns one match + populated submissions; rule consumes them', {
    skip: 'MorphiorDB API disabled — re-enable when client lookups are restored',
  }, async () => {
    // dan has no in-game prior round, but MorphiorDB has 2 historical points,
    // one near the target. Rule should find the near point and let dan escape.
    const okMorphior: MorphiorClient = {
      findPlayers: async () => [
        {
          discord_id: '1',
          canonical_name: 'dan',
          name: 'Dan',
          aliases: ['dan'],
        },
      ],
      fetchSubmissions: async () => [
        FAR_FROM_TARGET, // ~8500 km from Argentina target
        ARGENTINA_TARGET_COORDS, // 0 km from target
      ],
    };
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('bob', 20),
            makeSubmission('dan', 30),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: okMorphior,
    });
    assert.equal(result.dnsChecks[0].player, 'dan');
    assert.equal(result.dnsChecks[0].morphiorDbStatus, 'ok');
    assert.equal(result.dnsChecks[0].morphiorDbSubmissionCount, 2);
    // Closest point in MorphiorDB is the at-target coord.
    assert.deepEqual(result.dnsChecks[0].best?.point, ARGENTINA_TARGET_COORDS);
    // dan's bestDistance ~0 km < 50 km cutoff → could have escaped → no save.
    assert.equal(result.dnsChecks[0].couldHaveEscaped, true);
    assert.equal(result.savedSet.size, 0);
  });

  test('on-disk marker-color reflects post-rule state (saved player NOT red)', async () => {
    // Regression for code-review finding: applySimplestyle previously used
    // eliminationsForRound (distance-derived) and painted the saved player
    // red despite eliminated:false on disk.
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );
    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });
    assert.deepEqual([...result.savedSet].sort(), ['bob']);
    const onDisk = JSON.parse(await readFile(result.path, 'utf8'));
    const subs = onDisk.features.slice(1) as Array<{
      properties: { player: string; 'marker-color': string };
    }>;
    const colorFor = (player: string) =>
      subs.find((s) => s.properties.player === player)?.properties[
        'marker-color'
      ];
    // bob was saved by the rule; he must NOT be painted red.
    assert.notEqual(colorFor('bob'), '#ff0000');
  });

  test('re-end: reads persisted dnsChecks, no MorphiorDB call', async () => {
    let calls = 0;
    const counted: MorphiorClient = {
      findPlayers: async () => {
        calls += 1;
        return [];
      },
      fetchSubmissions: async () => {
        calls += 1;
        return [];
      },
    };

    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const first = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: counted,
    });
    // MorphiorDB calls are disabled; first-run also makes zero calls. The
    // load-bearing invariant is still that re-end adds none.
    const callsAfterFirst = calls;

    const second = await endRound({
      roundsDir: dir,
      explicitRound: 2,
      now: () => Instant.parse('2026-05-07T01:00:00Z'),
      morphiorClient: counted,
    });

    assert.equal(second.wasAlreadyEnded, true);
    assert.equal(calls, callsAfterFirst, 're-end must not call MorphiorDB');
    // Persisted state survives the round-trip.
    assert.deepEqual([...second.savedSet].sort(), [...first.savedSet].sort());
    assert.equal(second.dnsChecks.length, 1);
    assert.equal(second.dnsChecks[0].player, 'dan');
    assert.equal(second.dnsChecks[0].couldHaveEscaped, false);
  });

  test('endRound throws if previous round is in-progress (precondition)', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [makeSubmission('alice', 5)]),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 5)]),
    );

    await assert.rejects(
      endRound({
        roundsDir: dir,
        explicitRound: 2,
        now: fixedNow,
        morphiorClient: emptyMorphior(),
      }),
      /previous round 1 must be ended/,
    );
  });
});

describe('endRound — output formatting (U5)', () => {
  const FAR_FROM_TARGET: [number, number] = [0, 0];

  test('save fires: output names saved player + cites triggering DNS check', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
      lookupLocation: () => 'Pacific Ocean',
    });

    assert.match(result.output, /Saved by honest-DNS rule:/);
    assert.match(
      result.output,
      /bob \(triggered by dan's best historical at \d/,
    );
    assert.match(result.output, /DNS could-have-sent:/);
    assert.match(result.output, /dan: \d+\.\d{3} km from target/);
    assert.match(result.output, /Pacific Ocean/);
  });

  test('no save: DNS could-have-sent section still rendered', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('carol', 30), // default coord = target → could escape
            makeSubmission('dan', 100),
          ],
          ['dan'],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
      lookupLocation: () => 'Río Negro, Argentina',
    });

    assert.doesNotMatch(result.output, /Saved by honest-DNS rule/);
    assert.match(result.output, /DNS could-have-sent:/);
    assert.match(result.output, /carol: 0\.000 km from target/);
    assert.match(result.output, /Río Negro, Argentina/);
  });

  test('zero DNS: neither new section appears', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(1, null, [
        makeSubmission('alice', 10),
        makeSubmission('bob', 100),
      ]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
    });

    assert.doesNotMatch(result.output, /Saved by honest-DNS rule/);
    assert.doesNotMatch(result.output, /DNS could-have-sent/);
  });

  test('null lookupLocation result: renders coords without region label', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [makeSubmission('alice', 5), makeSubmission('carol', 30)],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 5)]),
    );

    const result = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
      lookupLocation: () => null, // ocean / unresolved
    });

    // Coord line should NOT contain a comma after the coords (no region label).
    assert.match(
      result.output,
      /carol: 0\.000 km from target \(\d+\.\d{5}°[NS] \d+\.\d{5}°[EW]\)/,
    );
  });

  test('idempotent re-end: identical output text on second run', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      makeRound(
        1,
        '2026-05-06T12:00:00Z',
        withEliminated(
          [
            makeSubmission('alice', 5),
            makeSubmission('dan', 200, FAR_FROM_TARGET),
          ],
          [],
        ),
      ),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 50),
      ]),
    );

    const stubLookup = () => 'Pacific Ocean';
    const first = await endRound({
      roundsDir: dir,
      now: fixedNow,
      morphiorClient: emptyMorphior(),
      lookupLocation: stubLookup,
    });
    const second = await endRound({
      roundsDir: dir,
      explicitRound: 2,
      now: () => Instant.parse('2026-05-07T01:00:00Z'),
      morphiorClient: emptyMorphior(),
      lookupLocation: stubLookup,
    });

    assert.equal(second.output, first.output);
  });
});
