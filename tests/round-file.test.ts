import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { endedAtOf, type RoundFile } from '../src/round-domain.ts';
import {
  findActiveRound,
  findLatestRound,
  listRoundFiles,
  parseRoundNumber,
  readRound,
  roundPath,
  writeRoundAtomic,
} from '../src/round-file.ts';

function makeRoundFile(
  round: number,
  endedAt: string | null = null,
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number: round, endedAt },
    features: [
      {
        type: 'Feature',
        id: 'target',
        geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
        properties: { location: 'Río Negro, Argentina' },
      },
    ],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tpg-round-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('roundPath / parseRoundNumber', () => {
  test('roundPath formats with zero-padded 3-digit number', () => {
    assert.equal(roundPath(3, 'rounds'), 'rounds/003.geojson');
    assert.equal(roundPath(1, 'rounds'), 'rounds/001.geojson');
    assert.equal(roundPath(123, 'rounds'), 'rounds/123.geojson');
  });

  test('roundPath rejects non-positive integers', () => {
    assert.throws(() => roundPath(0));
    assert.throws(() => roundPath(-1));
    assert.throws(() => roundPath(1.5));
  });

  test('parseRoundNumber accepts well-formed names', () => {
    assert.equal(parseRoundNumber('rounds/003.geojson'), 3);
    assert.equal(parseRoundNumber('001.geojson'), 1);
    assert.equal(parseRoundNumber('1234.geojson'), 1234);
  });

  test('parseRoundNumber rejects non-conforming names', () => {
    assert.equal(parseRoundNumber('round-3.geojson'), null);
    assert.equal(parseRoundNumber('3.geojson'), null);
    assert.equal(parseRoundNumber('003.json'), null);
    assert.equal(parseRoundNumber('README.md'), null);
  });
});

describe('listRoundFiles', () => {
  test('empty dir → empty array', async () => {
    assert.deepEqual(await listRoundFiles(dir), []);
  });

  test('non-existent dir → empty array', async () => {
    assert.deepEqual(await listRoundFiles(join(dir, 'no-such')), []);
  });

  test('returns rounds sorted ascending; ignores non-round files', async () => {
    await writeFile(join(dir, '003.geojson'), '{}');
    await writeFile(join(dir, '001.geojson'), '{}');
    await writeFile(join(dir, '002.geojson'), '{}');
    await writeFile(join(dir, 'README.md'), 'ignore me');
    const result = await listRoundFiles(dir);
    assert.deepEqual(
      result.map((r) => r.round),
      [1, 2, 3],
    );
    assert.equal(result[0].path, join(dir, '001.geojson'));
  });
});

describe('readRound', () => {
  test('parses a well-formed round file', async () => {
    const file = makeRoundFile(1);
    const path = join(dir, '001.geojson');
    await writeFile(path, JSON.stringify(file, null, 2));
    const result = await readRound(path);
    assert.equal(endedAtOf(result), null);
    assert.equal(result.features[0].id, 'target');
  });

  test('rejects malformed JSON', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(path, '{ not valid json');
    await assert.rejects(readRound(path), /invalid JSON/);
  });

  test('rejects missing target', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(
      path,
      JSON.stringify({
        type: 'FeatureCollection',
        roundInfo: { number: 1, endedAt: null },
        features: [],
      }),
    );
    await assert.rejects(readRound(path), /features array is empty/);
  });

  test('rejects target without id="target"', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid fixture
    (bad.features[0] as any).id = 'something-else';
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readRound(path), /id: "target"/);
  });

  test('rejects target with player property', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid fixture
    (bad.features[0].properties as any).player = 'alice';
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readRound(path), /must not have a player property/);
  });

  test('rejects FeatureCollection without roundInfo', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(
      path,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'target',
            geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
            properties: { location: 'Río Negro, Argentina' },
          },
        ],
      }),
    );
    await assert.rejects(readRound(path), /roundInfo must be an object/);
  });

  test('rejects roundInfo without endedAt', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(
      path,
      JSON.stringify({
        type: 'FeatureCollection',
        roundInfo: { number: 1 },
        features: [
          {
            type: 'Feature',
            id: 'target',
            geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
            properties: { location: 'Río Negro, Argentina' },
          },
        ],
      }),
    );
    await assert.rejects(readRound(path), /roundInfo.*endedAt/);
  });

  test('rejects invalid endedAt string', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1, 'not-a-date');
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readRound(path), /ISO 8601/);
  });

  test('rejects roundInfo.number that disagrees with filename', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(2);
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readRound(path), /does not match filename/);
  });

  test('rejects roundInfo.language that is not a string', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(
      path,
      JSON.stringify({
        type: 'FeatureCollection',
        roundInfo: { number: 1, endedAt: null, language: 42 },
        features: [
          {
            type: 'Feature',
            id: 'target',
            geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
            properties: { location: 'Río Negro, Argentina' },
          },
        ],
      }),
    );
    await assert.rejects(readRound(path), /language must be a string/);
  });

  test('rejects target without location', async () => {
    const path = join(dir, '001.geojson');
    await writeFile(
      path,
      JSON.stringify({
        type: 'FeatureCollection',
        roundInfo: { number: 1, endedAt: null },
        features: [
          {
            type: 'Feature',
            id: 'target',
            geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
            properties: {},
          },
        ],
      }),
    );
    await assert.rejects(readRound(path), /properties\.location/);
  });

  test('rejects submission without player or distance', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1) as RoundFile & { features: unknown[] };
    bad.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { distance: 5 }, // missing player
    });
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readRound(path), /properties.player/);
  });

  test('rejects in-progress round whose submission carries `eliminated`', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1, null) as RoundFile & { features: unknown[] };
    bad.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { player: 'alice', distance: 5, eliminated: false },
    });
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(
      readRound(path),
      /in-progress round and must not have properties.eliminated/,
    );
  });

  test('rejects ended round whose submission is missing `eliminated`', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1, '2026-05-06T12:00:00Z') as RoundFile & {
      features: unknown[];
    };
    bad.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { player: 'alice', distance: 5 }, // no eliminated
    });
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(
      readRound(path),
      /ended round must have properties.eliminated/,
    );
  });

  test('rejects ended round whose `eliminated` is not a boolean', async () => {
    const path = join(dir, '001.geojson');
    const bad = makeRoundFile(1, '2026-05-06T12:00:00Z') as RoundFile & {
      features: unknown[];
    };
    bad.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { player: 'alice', distance: 5, eliminated: 'yes' },
    });
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(
      readRound(path),
      /ended round must have properties.eliminated/,
    );
  });

  test('accepts an ended round whose every submission has `eliminated: boolean`', async () => {
    const path = join(dir, '001.geojson');
    const ok = makeRoundFile(1, '2026-05-06T12:00:00Z') as RoundFile & {
      features: unknown[];
    };
    ok.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { player: 'alice', distance: 5, eliminated: false },
    });
    ok.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { player: 'bob', distance: 99, eliminated: true },
    });
    await writeFile(path, JSON.stringify(ok));
    const round = await readRound(path);
    assert.equal(round.features.length, 3);
  });
});

describe('writeRoundAtomic', () => {
  test('produces the file at the target path; no .tmp lingers', async () => {
    const file = makeRoundFile(1);
    const path = join(dir, '001.geojson');
    await writeRoundAtomic(path, file);

    const entries = await readdir(dir);
    assert.deepEqual(entries.sort(), ['001.geojson']);

    const written = await readFile(path, 'utf8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.type, 'FeatureCollection');
    assert.equal(parsed.properties, undefined);
    assert.equal(parsed.roundInfo.number, 1);
    assert.equal(parsed.roundInfo.endedAt, null);
    assert.equal(parsed.features[0].id, 'target');
    assert.equal(parsed.features[0].properties.ended_at, undefined);
  });
});

describe('findActiveRound / findLatestRound', () => {
  test('empty dir → null', async () => {
    assert.equal(await findActiveRound(dir), null);
    assert.equal(await findLatestRound(dir), null);
  });

  test('only ended rounds → findActiveRound null; findLatestRound returns highest', async () => {
    const r1 = makeRoundFile(1, '2026-05-06T12:00:00Z');
    const r2 = makeRoundFile(2, '2026-05-06T13:00:00Z');
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), r2);

    assert.equal(await findActiveRound(dir), null);
    const latest = await findLatestRound(dir);
    assert.equal(latest?.entry.round, 2);
    assert.equal(latest && endedAtOf(latest.file), '2026-05-06T13:00:00Z');
  });

  test('mix of ended + open → findActiveRound returns highest open', async () => {
    const r1 = makeRoundFile(1, '2026-05-06T12:00:00Z');
    const r2 = makeRoundFile(2, null);
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), r2);

    const active = await findActiveRound(dir);
    assert.equal(active?.entry.round, 2);
    assert.equal(active && endedAtOf(active.file), null);
  });
});
