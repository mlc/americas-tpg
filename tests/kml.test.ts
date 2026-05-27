import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { create } from 'xmlbuilder2';
import {
  buildRoundsKmlDocument,
  buildRoundsKmz,
  collectPinIds,
  generateKmz,
} from '../src/kml.ts';
import type {
  RoundFeature,
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import { applySimplestyle } from '../src/simplestyle.ts';
import { withEliminated } from './test-helpers.ts';

const T1 = '2026-05-01T12:00:00Z';
const T2 = '2026-05-02T12:00:00Z';

function target(
  coordinates: [number, number] = [-67.5, -42.5],
  location = 'Río Negro, Argentina',
): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates },
    properties: { player: 'Target', distance: null, location },
  };
}

function sub(
  player: string,
  distance: number,
  coordinates: [number, number] = [0, 0],
): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: { player, distance },
  };
}

function endedRound(
  number: number,
  endedAt: string,
  submissions: SubmissionFeature[],
  targetFeature: TargetFeature = target(),
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number, endedAt, dnsChecks: [] },
    features: [targetFeature, ...submissions],
  };
}

function openRound(
  number: number,
  submissions: SubmissionFeature[],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number, endedAt: null },
    features: [target(), ...submissions],
  };
}

/** A styled (marker-* stamped) round, as the builder sees it on disk. */
function styledEnded(
  number: number,
  endedAt: string,
  submissions: SubmissionFeature[],
  eliminated: string[] = [],
  targetFeature?: TargetFeature,
): RoundFile {
  return applySimplestyle(
    endedRound(
      number,
      endedAt,
      withEliminated(submissions, eliminated),
      targetFeature,
    ),
  );
}

/** Inject explicit marker-* props onto a feature (bypassing the domain types,
 * as `applySimplestyle` does at runtime). */
function withMarker(
  feature: RoundFeature,
  symbol: string,
  color: string,
): RoundFeature {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      'marker-symbol': symbol,
      'marker-color': color,
    },
  } as unknown as RoundFeature;
}

function roundOf(...features: RoundFeature[]): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number: 1, endedAt: T1, dnsChecks: [] },
    features,
  };
}

const countOf = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const allMatches = (s: string, re: RegExp): string[] =>
  [...s.matchAll(re)].map((m) => m[1]);

const PODIUM_IDS = [
  's_circle_444444',
  's_circle_c0c0c0',
  's_circle_cd7f32',
  's_circle_d4af37',
  's_circle_ff0000',
  's_star_000000',
];

describe('collectPinIds', () => {
  test('distinct, sorted pin ids across a styled round', () => {
    // a=gold, b=silver, c=bronze, d=gray, e=red(last) + target star.
    const r1 = styledEnded(
      1,
      T1,
      [sub('a', 10), sub('b', 20), sub('c', 30), sub('d', 40), sub('e', 50)],
      ['e'],
    );
    assert.deepEqual(collectPinIds([r1]), PODIUM_IDS);
  });

  test('a feature without marker-* clamps to the gray circle pin', () => {
    const raw = endedRound(1, T1, withEliminated([sub('alice', 10)], []));
    assert.deepEqual(collectPinIds([raw]), ['s_circle_444444']);
  });

  test('an unknown marker color clamps to a known pin (no missing image)', () => {
    const r = roundOf(
      withMarker(target(), 'star', '#123456'),
      withMarker(sub('alice', 10), 'circle', '#123456'),
    );
    assert.deepEqual(collectPinIds([r]), ['s_circle_444444', 's_star_000000']);
  });
});

describe('buildRoundsKmlDocument', () => {
  test('empty input throws', () => {
    assert.throws(() => buildRoundsKmlDocument([]), /no rounds to export/);
  });

  test('one Folder per round, named "Round N", in input order', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]);
    const r2 = styledEnded(2, T2, [sub('bob', 20)]);
    const kml = buildRoundsKmlDocument([r1, r2]);
    assert.equal(countOf(kml, /<Folder>/g), 2);
    const folderNames = allMatches(kml, /<Folder>\s*<name>([^<]*)<\/name>/g);
    assert.deepEqual(folderNames, ['Round 1', 'Round 2']);
  });

  test('one Placemark per feature; target placemark is named "Target"', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10), sub('bob', 20)]);
    const kml = buildRoundsKmlDocument([r1]);
    assert.equal(countOf(kml, /<Placemark>/g), 3);
    const names = allMatches(kml, /<Placemark>\s*<name>([^<]*)<\/name>/g);
    assert.deepEqual(names, ['Target', 'alice', 'bob']);
  });

  test('placemark name is the player verbatim; XML metachars escaped', () => {
    const r1 = styledEnded(1, T1, [sub('A & B <x>', 10)]);
    const kml = buildRoundsKmlDocument([r1]);
    assert.match(kml, /<name>A &amp; B &lt;x&gt;<\/name>/);
    assert.doesNotThrow(() => create(kml));
  });

  test('emoji player names survive unescaped in UTF-8', () => {
    const r1 = styledEnded(1, T1, [sub('Martin 🇳🇱', 10)]);
    const kml = buildRoundsKmlDocument([r1]);
    assert.match(kml, /<name>Martin 🇳🇱<\/name>/);
  });

  test('styles reference bundled images/<id>.png with hotSpot and hidden label', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]); // gold + target star
    const kml = buildRoundsKmlDocument([r1]);
    assert.match(
      kml,
      /<Style id="s_circle_d4af37">\s*<IconStyle>\s*<scale>1<\/scale>\s*<Icon>\s*<href>images\/s_circle_d4af37\.png<\/href>\s*<\/Icon>\s*<hotSpot x="32" y="64" xunits="pixels" yunits="insetPixels"\/>\s*<\/IconStyle>\s*<LabelStyle>\s*<scale>0<\/scale>/,
    );
    assert.match(kml, /<href>images\/s_star_000000\.png<\/href>/);
  });

  test('no KML <color> tint and no remote icon hrefs (color is baked into the PNG)', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]);
    const kml = buildRoundsKmlDocument([r1]);
    assert.doesNotMatch(kml, /<color>/);
    assert.doesNotMatch(kml, /maps\.google\.com/);
  });

  test('every styleUrl references a defined Style id', () => {
    const r1 = styledEnded(1, T1, [sub('a', 10), sub('b', 20)], ['b']);
    const r2 = styledEnded(2, T2, [sub('a', 5)]);
    const kml = buildRoundsKmlDocument([r1, r2]);
    const ids = new Set(allMatches(kml, /<Style id="([^"]+)"/g));
    const refs = allMatches(kml, /<styleUrl>#([^<]+)<\/styleUrl>/g);
    assert.ok(refs.length > 0);
    for (const ref of refs)
      assert.ok(ids.has(ref), `dangling styleUrl #${ref}`);
  });

  test('coordinates are emitted lon,lat in that order', () => {
    const r1 = styledEnded(
      1,
      T1,
      [sub('alice', 10, [-65.97, -26.07])],
      [],
      target([-66.55809, -26.2263]),
    );
    const kml = buildRoundsKmlDocument([r1]);
    assert.match(kml, /<coordinates>-66\.55809,-26\.2263<\/coordinates>/);
    assert.match(kml, /<coordinates>-65\.97,-26\.07<\/coordinates>/);
  });

  test('target-only round yields one Placemark named Target', () => {
    const open = applySimplestyle(openRound(1, []));
    const kml = buildRoundsKmlDocument([open]);
    assert.equal(countOf(kml, /<Folder>/g), 1);
    assert.equal(countOf(kml, /<Placemark>/g), 1);
    assert.match(kml, /<Placemark>\s*<name>Target<\/name>/);
  });

  test('feature missing marker-* falls back to the gray circle pin', () => {
    const raw = endedRound(1, T1, withEliminated([sub('alice', 10)], []));
    const kml = buildRoundsKmlDocument([raw]);
    assert.match(kml, /<Style id="s_circle_444444">/);
    assert.match(kml, /<styleUrl>#s_circle_444444<\/styleUrl>/);
    assert.doesNotThrow(() => create(kml));
  });

  test('output is a well-formed KML 2.2 document', () => {
    const kml = buildRoundsKmlDocument([
      styledEnded(1, T1, [sub('alice', 10)]),
    ]);
    assert.match(kml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
    const obj = create(kml).end({ format: 'object' }) as {
      kml: { Document: unknown };
    };
    assert.ok(obj.kml.Document);
  });
});

describe('buildRoundsKmz', () => {
  test('zips doc.kml plus one images/<id>.png per distinct pin', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]); // gold + target star
    const loaded: string[] = [];
    const kmz = buildRoundsKmz([r1], (id) => {
      loaded.push(id);
      return new Uint8Array([1, 2, 3]);
    });
    const entries = unzipSync(kmz);
    const names = Object.keys(entries).sort();
    assert.deepEqual(names, [
      'doc.kml',
      'images/s_circle_d4af37.png',
      'images/s_star_000000.png',
    ]);
    assert.deepEqual(loaded.sort(), ['s_circle_d4af37', 's_star_000000']);
    assert.deepEqual([...entries['images/s_star_000000.png']], [1, 2, 3]);
    assert.match(strFromU8(entries['doc.kml']), /<kml xmlns=/);
  });
});

describe('generateKmz', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tpg-kmz-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('throws on empty rounds dir', async () => {
    await assert.rejects(generateKmz({ roundsDir: dir }), /no ended rounds/);
  });

  test('throws when only in-progress rounds exist', async () => {
    await writeRoundAtomic(roundPath(1, dir), openRound(1, [sub('alice', 10)]));
    await assert.rejects(generateKmz({ roundsDir: dir }), /no ended rounds/);
  });

  test('bundles real pin assets and skips in-progress rounds', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      endedRound(
        1,
        T1,
        withEliminated([sub('alice', 10), sub('bob', 20)], ['bob']),
      ),
    );
    await writeRoundAtomic(roundPath(2, dir), openRound(2, [sub('carol', 5)]));
    const { kmz, rounds } = await generateKmz({ roundsDir: dir });
    assert.equal(rounds, 1);

    const entries = unzipSync(kmz);
    assert.ok(entries['doc.kml'], 'doc.kml present');
    const kml = strFromU8(entries['doc.kml']);
    assert.match(kml, /<name>Round 1<\/name>/);
    assert.doesNotMatch(kml, /<name>Round 2<\/name>/);
    // alice = gold (closest), bob = red (last) + target star.
    for (const id of ['s_circle_d4af37', 's_circle_ff0000', 's_star_000000']) {
      const png = entries[`images/${id}.png`];
      assert.ok(png, `bundled images/${id}.png`);
      // Real PNG bytes start with the PNG signature.
      assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
