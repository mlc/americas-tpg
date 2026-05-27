import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { create } from 'xmlbuilder2';
import {
  buildRoundsKml,
  generateKml,
  iconHrefForSymbol,
  simplestyleColorToKml,
} from '../src/kml.ts';
import type {
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

const countOf = (kml: string, re: RegExp): number =>
  (kml.match(re) ?? []).length;

const allMatches = (kml: string, re: RegExp): string[] =>
  [...kml.matchAll(re)].map((m) => m[1]);

describe('simplestyleColorToKml', () => {
  test('reverses rrggbb to bbggrr with ff opacity', () => {
    assert.equal(simplestyleColorToKml('#d4af37'), 'ff37afd4');
    assert.equal(simplestyleColorToKml('#000000'), 'ff000000');
    assert.equal(simplestyleColorToKml('#ff0000'), 'ff0000ff');
    assert.equal(simplestyleColorToKml('#c0c0c0'), 'ffc0c0c0');
    assert.equal(simplestyleColorToKml('#cd7f32'), 'ff327fcd');
  });

  test('accepts uppercase, a missing leading #, and surrounding whitespace', () => {
    assert.equal(simplestyleColorToKml('#D4AF37'), 'ff37afd4');
    assert.equal(simplestyleColorToKml('d4af37'), 'ff37afd4');
    assert.equal(simplestyleColorToKml(' #d4af37 '), 'ff37afd4');
  });

  test('malformed input falls back to default-player gray', () => {
    assert.equal(simplestyleColorToKml('nope'), 'ff444444');
    assert.equal(simplestyleColorToKml(''), 'ff444444');
  });
});

describe('iconHrefForSymbol', () => {
  test('star maps to the star icon', () => {
    assert.match(iconHrefForSymbol('star'), /\/star\.png$/);
  });

  test('circle and anything unknown map to the circle icon', () => {
    assert.match(iconHrefForSymbol('circle'), /\/placemark_circle\.png$/);
    assert.match(iconHrefForSymbol('mystery'), /\/placemark_circle\.png$/);
  });
});

describe('buildRoundsKml', () => {
  test('empty input throws', () => {
    assert.throws(() => buildRoundsKml([]), /no rounds to export/);
  });

  test('one Folder per round, named "Round N", in input order', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]);
    const r2 = styledEnded(2, T2, [sub('bob', 20)]);
    const kml = buildRoundsKml([r1, r2]);
    assert.equal(countOf(kml, /<Folder>/g), 2);
    const folderNames = allMatches(kml, /<Folder>\s*<name>([^<]*)<\/name>/g);
    assert.deepEqual(folderNames, ['Round 1', 'Round 2']);
  });

  test('one Placemark per feature; target placemark is named "Target"', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10), sub('bob', 20)]);
    const kml = buildRoundsKml([r1]);
    // target + 2 submissions = 3 placemarks.
    assert.equal(countOf(kml, /<Placemark>/g), 3);
    const names = allMatches(kml, /<Placemark>\s*<name>([^<]*)<\/name>/g);
    assert.deepEqual(names, ['Target', 'alice', 'bob']);
  });

  test('placemark name is the player verbatim; XML metachars escaped', () => {
    const r1 = styledEnded(1, T1, [sub('A & B <x>', 10)]);
    const kml = buildRoundsKml([r1]);
    assert.match(kml, /<name>A &amp; B &lt;x&gt;<\/name>/);
    assert.doesNotMatch(kml, /<name>A & B <x><\/name>/);
    // And the whole document still re-parses as well-formed XML.
    assert.doesNotThrow(() => create(kml));
  });

  test('emoji player names survive unescaped in UTF-8', () => {
    const r1 = styledEnded(1, T1, [sub('Martin 🇳🇱', 10)]);
    const kml = buildRoundsKml([r1]);
    assert.match(kml, /<name>Martin 🇳🇱<\/name>/);
  });

  test('K distinct (symbol,color) pairs yield K shared Styles', () => {
    // gold (closest), silver, bronze, gray, red(last) + target star = 6 colors,
    // 2 symbols (star, circle) → 6 distinct (symbol,color) pairs.
    const r1 = styledEnded(
      1,
      T1,
      [sub('a', 10), sub('b', 20), sub('c', 30), sub('d', 40), sub('e', 50)],
      ['e'],
    );
    const kml = buildRoundsKml([r1]);
    assert.equal(countOf(kml, /<Style id="/g), 6);
  });

  test('every styleUrl references a defined Style id', () => {
    const r1 = styledEnded(1, T1, [sub('a', 10), sub('b', 20)], ['b']);
    const r2 = styledEnded(2, T2, [sub('a', 5)]);
    const kml = buildRoundsKml([r1, r2]);
    const ids = new Set(allMatches(kml, /<Style id="([^"]+)"/g));
    const refs = allMatches(kml, /<styleUrl>#([^<]+)<\/styleUrl>/g);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.ok(ids.has(ref), `styleUrl #${ref} has no matching <Style id>`);
    }
  });

  test('styles carry the converted color and the symbol icon href', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]); // alice = closest = gold
    const kml = buildRoundsKml([r1]);
    // target: star + black.
    assert.match(
      kml,
      /<Style id="s_star_000000">\s*<IconStyle>\s*<color>ff000000<\/color>\s*<Icon>\s*<href>[^<]*\/star\.png<\/href>/,
    );
    // gold player: circle + ff37afd4.
    assert.match(
      kml,
      /<Style id="s_circle_d4af37">\s*<IconStyle>\s*<color>ff37afd4<\/color>\s*<Icon>\s*<href>[^<]*\/placemark_circle\.png<\/href>/,
    );
  });

  test('coordinates are emitted lon,lat in that order', () => {
    const r1 = styledEnded(
      1,
      T1,
      [sub('alice', 10, [-65.97, -26.07])],
      [],
      target([-66.55809, -26.2263]),
    );
    const kml = buildRoundsKml([r1]);
    assert.match(kml, /<coordinates>-66\.55809,-26\.2263<\/coordinates>/);
    assert.match(kml, /<coordinates>-65\.97,-26\.07<\/coordinates>/);
  });

  test('target-only round yields one Placemark named Target', () => {
    // Freshly created / active round: features = [target], zero submissions.
    const open = applySimplestyle(openRound(1, []));
    const kml = buildRoundsKml([open]);
    assert.equal(countOf(kml, /<Folder>/g), 1);
    assert.equal(countOf(kml, /<Placemark>/g), 1);
    assert.match(kml, /<Placemark>\s*<name>Target<\/name>/);
  });

  test('feature missing marker-* falls back to a gray circle', () => {
    // Raw fixture, never run through applySimplestyle → no marker-* props.
    const raw = endedRound(1, T1, withEliminated([sub('alice', 10)], []));
    const kml = buildRoundsKml([raw]);
    assert.match(kml, /<Style id="s_circle_444444">/);
    assert.match(kml, /<color>ff444444<\/color>/);
    // No throw, valid XML.
    assert.doesNotThrow(() => create(kml));
  });

  test('output is a well-formed KML 2.2 document', () => {
    const r1 = styledEnded(1, T1, [sub('alice', 10)]);
    const kml = buildRoundsKml([r1]);
    assert.match(kml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
    const obj = create(kml).end({ format: 'object' }) as {
      kml: { Document: unknown };
    };
    assert.ok(obj.kml.Document, 'expected a <Document> under <kml>');
  });
});

describe('generateKml', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tpg-kml-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('throws on empty rounds dir', async () => {
    await assert.rejects(generateKml({ roundsDir: dir }), /no ended rounds/);
  });

  test('throws when only in-progress rounds exist', async () => {
    await writeRoundAtomic(roundPath(1, dir), openRound(1, [sub('alice', 10)]));
    await assert.rejects(generateKml({ roundsDir: dir }), /no ended rounds/);
  });

  test('in-progress latest round is skipped; only ended rounds emitted', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      endedRound(
        1,
        T1,
        withEliminated([sub('alice', 10), sub('bob', 20)], ['bob']),
      ),
    );
    await writeRoundAtomic(roundPath(2, dir), openRound(2, [sub('alice', 5)]));
    const { kml, rounds } = await generateKml({ roundsDir: dir });
    assert.equal(rounds, 1);
    assert.match(kml, /<name>Round 1<\/name>/);
    assert.doesNotMatch(kml, /<name>Round 2<\/name>/);
    assert.match(kml, /<name>alice<\/name>/);
  });

  test('exports every ended round as its own Folder', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      endedRound(1, T1, withEliminated([sub('alice', 10)], [])),
    );
    await writeRoundAtomic(
      roundPath(2, dir),
      endedRound(2, T2, withEliminated([sub('alice', 11)], [])),
    );
    const { kml, rounds } = await generateKml({ roundsDir: dir });
    assert.equal(rounds, 2);
    assert.equal(countOf(kml, /<Folder>/g), 2);
  });
});
