import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createRound } from '../src/create-round.ts';
import { endRound } from '../src/end-round.ts';
import type {
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import { submitRound } from '../src/submit-round.ts';
import { withEliminated } from './test-helpers.ts';

function makeArgentinaTarget(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: { location: 'Río Negro, Argentina' },
  };
}

const argentinaTarget = makeArgentinaTarget();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tpg-end-round-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeSubmission(player: string, distance: number): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { player, distance },
  };
}

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

const fixedNow = () => new Date('2026-05-07T00:00:00Z');

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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

    assert.deepEqual([...result.eliminations], ['carol']);
    assert.deepEqual([...result.dnsSet], []);
    assert.deepEqual([...result.nextEligible].sort(), ['alice', 'bob']);
    assert.match(result.output, /Standings:/);
    assert.match(result.output, /carol \(last place\)/);
    assert.match(result.output, /Round 2 starts with: alice, bob/);
    assert.equal(result.endedAt, '2026-05-07T00:00:00.000Z');
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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

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
    const result = await endRound({ roundsDir: dir, now: fixedNow });

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

    const first = await endRound({ roundsDir: dir, now: fixedNow });
    assert.equal(first.wasAlreadyEnded, false);
    assert.equal(first.endedAt, '2026-05-07T00:00:00.000Z');

    // Re-run with explicit --round 1 (default findActiveRound would skip ended)
    const second = await endRound({
      roundsDir: dir,
      explicitRound: 1,
      now: () => new Date('2026-05-07T01:00:00Z'), // different time
    });

    assert.equal(second.wasAlreadyEnded, true);
    // endedAt unchanged from first run despite different "now"
    assert.equal(second.endedAt, '2026-05-07T00:00:00.000Z');
    // Output is identical
    assert.equal(second.output, first.output);

    // On-disk file's endedAt is still the original
    const onDisk = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(onDisk.roundInfo.endedAt, '2026-05-07T00:00:00.000Z');
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

    await endRound({ roundsDir: dir, now: fixedNow });
    const onDisk = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));
    const onDiskEndedAt = onDisk.roundInfo.endedAt;
    assert.equal(typeof onDiskEndedAt, 'string');
    assert.equal(Number.isNaN(Date.parse(onDiskEndedAt)), false);
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

    await endRound({ roundsDir: dir, now: fixedNow });
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
    await endRound({ roundsDir: dir, now: fixedNow });
    const first = JSON.parse(await readFile(roundPath(1, dir), 'utf8'));

    await endRound({
      roundsDir: dir,
      explicitRound: 1,
      now: () => new Date('2026-05-07T01:00:00Z'),
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

    const result = await endRound({ roundsDir: dir, now: fixedNow });
    assert.deepEqual([...result.eliminations], ['carol']);
    assert.deepEqual([...result.nextEligible].sort(), ['alice', 'bob']);
    assert.match(result.output, /Round 2 starts with: alice, bob/);
  });
});
