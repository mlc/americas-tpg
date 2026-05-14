import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  buildLeaderboardMarkdown,
  generateLeaderboard,
} from '../src/leaderboard.ts';
import type {
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import { withEliminated } from './test-helpers.ts';

function target(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: {
      player: 'Target',
      distance: null,
      location: 'Río Negro, Argentina',
    },
  };
}

function sub(player: string, distance: number): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { player, distance },
  };
}

function endedRound(
  number: number,
  endedAt: string,
  submissions: SubmissionFeature[],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number, endedAt, dnsChecks: [] },
    features: [target(), ...submissions],
  };
}

function openRound(
  number: number,
  submissions: SubmissionFeature[] = [],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: { number, endedAt: null },
    features: [target(), ...submissions],
  };
}

const T1 = '2026-05-01T12:00:00Z';
const T2 = '2026-05-02T12:00:00Z';
const T3 = '2026-05-03T12:00:00Z';

/** Extract the Player column values (cell 1 of each table row) from the
 * built markdown, skipping the header and separator rows. */
function playerNamesFromMarkdown(md: string): string[] {
  const rows = md
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
  // rows[0] is the header.
  return rows.slice(1).map((l) => l.split('|')[1].trim());
}

describe('buildLeaderboardMarkdown', () => {
  test('empty input throws', () => {
    assert.throws(() => buildLeaderboardMarkdown([]), /no ended rounds/);
  });

  test('rejects in-progress rounds', () => {
    assert.throws(
      () => buildLeaderboardMarkdown([openRound(1, [sub('a', 10)])]),
      /not ended/,
    );
  });

  test('single round: one elimination bolded, survivor plain, eliminated name italic', () => {
    const r1 = endedRound(
      1,
      T1,
      withEliminated([sub('alice', 10.4), sub('bob', 99.7)], ['bob']),
    );
    const md = buildLeaderboardMarkdown([r1]);
    assert.match(md, /^# Leaderboard\n\n/);
    assert.match(
      md,
      /\| Player \| \[Round 1\]\(https:\/\/geojson\.io\/#id=github:mlc\/americas-tpg\/blob\/main\/rounds\/001\.geojson\) \|/,
    );
    // Survivor plain, eliminated italic, elim cell bold (rounded).
    assert.match(md, /\| alice \| 10 \|/);
    assert.match(md, /\| \*bob\* \| \*\*100\*\* \|/);
    // Survivor row comes before eliminated row.
    assert.ok(md.indexOf('| alice |') < md.indexOf('| *bob* |'));
  });

  test('multi-round: survivors first (alpha), eliminated by elim-round desc then alpha; eliminated names italic', () => {
    // R1: a, b, c, d submit. d eliminated.
    const r1 = endedRound(
      1,
      T1,
      withEliminated(
        [sub('alice', 10), sub('bob', 20), sub('carol', 30), sub('dave', 40)],
        ['dave'],
      ),
    );
    // R2: a, b, c submit. c eliminated.
    const r2 = endedRound(
      2,
      T2,
      withEliminated(
        [sub('alice', 11), sub('bob', 22), sub('carol', 44)],
        ['carol'],
      ),
    );
    // R3: a, b submit. b eliminated.
    const r3 = endedRound(
      3,
      T3,
      withEliminated([sub('alice', 5), sub('bob', 55)], ['bob']),
    );

    const md = buildLeaderboardMarkdown([r1, r2, r3]);
    const names = playerNamesFromMarkdown(md);
    assert.deepEqual(names, ['alice', '*bob*', '*carol*', '*dave*']);
  });

  test('DNS-out player: eligible in R2 but did not submit; shows DNS, treated as eliminated in R2', () => {
    const r1 = endedRound(
      1,
      T1,
      withEliminated([sub('alice', 10), sub('bob', 20)], []),
    );
    const r2 = endedRound(2, T2, withEliminated([sub('alice', 11)], []));
    const md = buildLeaderboardMarkdown([r1, r2]);
    // bob DNS'd in R2 — italicized, R1 cell shows 20, R2 cell shows DNS.
    assert.match(md, /\| \*bob\* \| 20 \| DNS \|/);
    // alice survives.
    assert.match(md, /\| alice \| 10 \| 11 \|/);
  });

  test('late-joining player: R1-R2 cells blank, not DNS', () => {
    const r1 = endedRound(1, T1, withEliminated([sub('alice', 10)], []));
    const r2 = endedRound(
      2,
      T2,
      withEliminated([sub('alice', 11), sub('newbie', 12)], []),
    );
    const md = buildLeaderboardMarkdown([r1, r2]);
    // newbie row should have a blank cell for R1 (single space), and 12 for R2.
    assert.match(md, /\| newbie \| {3}\| 12 \|/);
  });

  test('case-insensitive alphabetical sort among survivors', () => {
    const r1 = endedRound(
      1,
      T1,
      withEliminated([sub('Bob', 10), sub('aLice', 20)], []),
    );
    const md = buildLeaderboardMarkdown([r1]);
    const names = playerNamesFromMarkdown(md);
    assert.deepEqual(names, ['aLice', 'Bob']);
  });

  test('player names with markdown metachars are escaped per cell', () => {
    const r1 = endedRound(
      1,
      T1,
      withEliminated(
        [sub('a|b', 10), sub('star*name', 20), sub('under_score', 30)],
        ['under_score'],
      ),
    );
    const md = buildLeaderboardMarkdown([r1]);
    // `|` must be escaped so the row keeps its column count.
    assert.match(md, /\| a\\\|b \| 10 \|/);
    // `*` and `_` must be escaped so emphasis doesn't fire.
    assert.match(md, /\| star\\\*name \| 20 \|/);
    // Eliminated row: the escape happens before the italic wrap, so
    // `under_score` becomes `*under\_score*` (italic markers around the
    // escaped name).
    assert.match(md, /\| \*under\\_score\* \| \*\*30\*\* \|/);
  });

  test('column header links use submissionTrackerUrl format', () => {
    const r1 = endedRound(1, T1, withEliminated([sub('alice', 5)], []));
    const r12 = endedRound(12, T2, withEliminated([sub('alice', 6)], []));
    const md = buildLeaderboardMarkdown([r1, r12]);
    assert.match(
      md,
      /\[Round 1\]\(https:\/\/geojson\.io\/#id=github:mlc\/americas-tpg\/blob\/main\/rounds\/001\.geojson\)/,
    );
    assert.match(
      md,
      /\[Round 12\]\(https:\/\/geojson\.io\/#id=github:mlc\/americas-tpg\/blob\/main\/rounds\/012\.geojson\)/,
    );
  });
});

describe('generateLeaderboard', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tpg-leaderboard-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('throws on empty rounds dir', async () => {
    await assert.rejects(
      generateLeaderboard({ roundsDir: dir }),
      /no ended rounds/,
    );
  });

  test('throws when only in-progress rounds exist', async () => {
    await writeRoundAtomic(roundPath(1, dir), openRound(1, [sub('alice', 10)]));
    await assert.rejects(
      generateLeaderboard({ roundsDir: dir }),
      /no ended rounds/,
    );
  });

  test('in-progress latest round is skipped; prior ended rounds drive the table', async () => {
    await writeRoundAtomic(
      roundPath(1, dir),
      endedRound(
        1,
        T1,
        withEliminated([sub('alice', 10), sub('bob', 20)], ['bob']),
      ),
    );
    await writeRoundAtomic(roundPath(2, dir), openRound(2, [sub('alice', 5)]));
    const { markdown, rounds } = await generateLeaderboard({ roundsDir: dir });
    assert.equal(rounds, 1);
    assert.match(markdown, /\| Player \| \[Round 1\]/);
    assert.doesNotMatch(markdown, /\[Round 2\]/);
    assert.match(markdown, /\| alice \| 10 \|/);
    assert.match(markdown, /\| \*bob\* \| \*\*20\*\* \|/);
  });

  test('end-to-end across two ended rounds (writes match on-disk reads)', async () => {
    const r1 = endedRound(
      1,
      T1,
      withEliminated(
        [sub('alice', 10), sub('bob', 20), sub('carol', 30)],
        ['carol'],
      ),
    );
    const r2 = endedRound(
      2,
      T2,
      withEliminated([sub('alice', 11), sub('bob', 22)], ['bob']),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), r2);
    const { markdown, rounds } = await generateLeaderboard({ roundsDir: dir });
    assert.equal(rounds, 2);
    // Order: alice (survivor), then bob (eliminated R2), then carol (eliminated R1).
    const names = playerNamesFromMarkdown(markdown);
    assert.deepEqual(names, ['alice', '*bob*', '*carol*']);
    // Sanity: alice has no italic markup.
    assert.match(markdown, /\| alice \| 10 \| 11 \|/);
    // bob's elim is in R2: bolded 22.
    assert.match(markdown, /\| \*bob\* \| 20 \| \*\*22\*\* \|/);
    // carol eliminated in R1: bolded 30, then blank for R2.
    assert.match(markdown, /\| \*carol\* \| \*\*30\*\* \| {3}\|/);
  });
});
