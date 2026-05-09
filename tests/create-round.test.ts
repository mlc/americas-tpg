import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createRound } from '../src/create-round.ts';
import type { RoundFile, TargetFeature } from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';

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
  dir = await mkdtemp(join(tmpdir(), 'tpg-create-round-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEndedRound(
  round: number,
  endedAt = '2026-05-06T12:00:00Z',
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number: round, endedAt, dnsChecks: [] },
    features: [makeArgentinaTarget()],
  };
}

function makeOpenRound(round: number): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number: round, endedAt: null },
    features: [makeArgentinaTarget()],
  };
}

describe('createRound', () => {
  test('empty rounds dir → creates 001.geojson with target as first feature', async () => {
    const result = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });

    assert.equal(result.round, 1);
    assert.equal(result.path, join(dir, '001.geojson'));
    assert.equal(result.file.roundInfo.number, 1);
    assert.equal(result.file.roundInfo.endedAt, null);
    assert.equal(result.file.features[0].id, 'target');
    assert.deepEqual(
      result.file.features[0].geometry.coordinates,
      [-67.5, -42.5],
    );
    assert.equal(
      (result.file.features[0] as TargetFeature).properties.location,
      'Río Negro, Argentina',
    );

    const onDisk = JSON.parse(await readFile(result.path, 'utf8'));
    assert.equal(onDisk.type, 'FeatureCollection');
    assert.equal(onDisk.properties, undefined);
    assert.equal(onDisk.roundInfo.number, 1);
    assert.equal(onDisk.roundInfo.endedAt, null);
    assert.equal(onDisk.features[0].properties.ended_at, undefined);
  });

  test('existing ended round 001 → creates 002.geojson', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeEndedRound(1));

    const result = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });

    assert.equal(result.round, 2);
    assert.equal(result.path, join(dir, '002.geojson'));
  });

  test('existing unended round 001 → refuses with active-round error (R15)', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeOpenRound(1));

    await assert.rejects(
      createRound({
        generateTarget: async () => ({ target: argentinaTarget }),
        roundsDir: dir,
      }),
      /still active/,
    );
  });

  test('skips multiple ended rounds and creates next', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeEndedRound(1));
    await writeRoundAtomic(roundPath(2, dir), makeEndedRound(2));
    await writeRoundAtomic(roundPath(3, dir), makeEndedRound(3));

    const result = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });

    assert.equal(result.round, 4);
    assert.equal(result.path, join(dir, '004.geojson'));
  });

  test('returned targetLine is Discord markdown with round, location, and link', async () => {
    const result = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });
    assert.equal(
      result.targetLine,
      '# Round 1, Río Negro, Argentina, [42.50000°S 67.50000°W](https://www.google.com/maps/search/?api=1&query=-42.5%2C-67.5)',
    );
  });

  test('does not overwrite an existing round (R4 / AE8)', async () => {
    // The natural-flow nextRound logic prevents overlap; the access guard is
    // defense-in-depth for genuine race conditions. This test confirms that
    // creating round 1, ending it, and creating round 2 leaves round 1 intact.
    const first = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });
    await writeRoundAtomic(first.path, makeEndedRound(1));

    const second = await createRound({
      generateTarget: async () => ({ target: argentinaTarget }),
      roundsDir: dir,
    });
    assert.equal(second.round, 2);
    const original = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(original.roundInfo.endedAt, '2026-05-06T12:00:00Z');
  });
});
