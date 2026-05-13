import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Instant } from '@js-joda/core';
import {
  eliminationsForRound,
  evaluateDnsCheck,
  formatLocation,
  formatRoundResultDiscord,
  formatStandings,
  formatTargetDiscord,
  normalizePlayerName,
  type RoundFile,
  RULES_URL,
  roundExpiry,
  type SubmissionFeature,
  submissionTrackerUrl,
  submitters,
  type TargetFeature,
  TIE_BUFFER_KM,
  validateSubmissionEligibility,
} from '../src/round-domain.ts';
import { withEliminated } from './test-helpers.ts';

// Fixed "now" for formatTargetDiscord tests: weekday afternoon in May, when
// New York is on EDT (UTC-4). Next-day 21:00 NY → 2026-05-14T01:00:00Z.
const NOW = Instant.parse('2026-05-12T14:00:00Z');
const EXPIRY_EPOCH = Instant.parse('2026-05-14T01:00:00Z').epochSecond();
const EXPIRY_LINE = `Submissions close <t:${EXPIRY_EPOCH}:R>`;

function makeTarget(): TargetFeature {
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

function submission(
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

function buildRound(
  round: number,
  endedAt: string | null,
  subs: SubmissionFeature[],
  language?: string,
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: {
      number: round,
      endedAt,
      ...(language ? { language } : {}),
    },
    features: [makeTarget(), ...subs],
  };
}

describe('formatLocation', () => {
  test('both name_0 and name_1 → "name_1, name_0"', () => {
    assert.equal(
      formatLocation({ name_0: 'Argentina', name_1: 'Río Negro' }),
      'Río Negro, Argentina',
    );
  });

  test('mainland-US case → "California, United States"', () => {
    assert.equal(
      formatLocation({ name_0: 'United States', name_1: 'California' }),
      'California, United States',
    );
  });

  test('only name_0 → "name_0"', () => {
    assert.equal(formatLocation({ name_0: 'Argentina' }), 'Argentina');
  });

  test('missing name_0 → null', () => {
    assert.equal(formatLocation({ name_1: 'Río Negro' }), null);
    assert.equal(formatLocation({}), null);
  });

  test('gid_0 with localized name → renders country in its main language', () => {
    assert.equal(
      formatLocation({ gid_0: 'BRA', name_0: 'Brazil', name_1: 'São Paulo' }),
      'São Paulo, Brasil',
    );
    assert.equal(
      formatLocation({ gid_0: 'HTI', name_0: 'Haiti', name_1: 'Ouest' }),
      'Ouest, Ayiti',
    );
    assert.equal(
      formatLocation({ gid_0: 'MEX', name_0: 'Mexico', name_1: 'Yucatán' }),
      'Yucatán, México',
    );
  });

  test('gid_0 not in table → falls back to name_0', () => {
    assert.equal(
      formatLocation({ gid_0: 'XYZ', name_0: 'Unknownland' }),
      'Unknownland',
    );
  });

  test('gid_0 with no name_0 → still localizes', () => {
    assert.equal(formatLocation({ gid_0: 'BRA' }), 'Brasil');
  });
});

describe('normalizePlayerName', () => {
  test('NFC + zero-width strip + trim', () => {
    assert.equal(normalizePlayerName('  alice  '), 'alice');
    assert.equal(normalizePlayerName('a​b'), 'ab');
  });

  test('rejects reserved Discord @-mention keywords (case-insensitive)', () => {
    assert.throws(
      () => normalizePlayerName('everyone'),
      /reserved Discord @-mention/,
    );
    assert.throws(
      () => normalizePlayerName('  HERE  '),
      /reserved Discord @-mention/,
    );
    assert.throws(
      () => normalizePlayerName('Everyone'),
      /reserved Discord @-mention/,
    );
  });

  test("non-reserved names with 'everyone' as a substring are accepted", () => {
    assert.equal(normalizePlayerName('everyone1'), 'everyone1');
    assert.equal(normalizePlayerName('mr_everyone'), 'mr_everyone');
  });
});

describe('submissionTrackerUrl', () => {
  test('zero-pads the round number to 3 digits and points at geojson.io', () => {
    assert.equal(
      submissionTrackerUrl(1),
      'https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/001.geojson',
    );
    assert.equal(
      submissionTrackerUrl(42),
      'https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/042.geojson',
    );
  });

  test('does not truncate four-digit round numbers', () => {
    assert.equal(
      submissionTrackerUrl(1234),
      'https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/1234.geojson',
    );
  });
});

describe('formatTargetDiscord', () => {
  test('renders Discord markdown with header, tracker link, rules link, and expiry', () => {
    assert.equal(
      formatTargetDiscord(buildRound(7, null, []), NOW),
      [
        '# Round 7, Río Negro, Argentina, [42.50000°S 67.50000°W](https://www.google.com/maps/search/?api=1&query=-42.5%2C-67.5)',
        '[Submission Tracker](https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/007.geojson)',
        '[Rules](https://github.com/mlc/americas-tpg/blob/main/RULES.md)',
        EXPIRY_LINE,
      ].join('\n'),
    );
  });

  test('positive lat/lng renders N/E and unsigned URL coords', () => {
    const positive: RoundFile = {
      type: 'FeatureCollection',
      roundInfo: { number: 1, endedAt: null },
      features: [
        {
          type: 'Feature',
          id: 'target',
          geometry: { type: 'Point', coordinates: [10.0, 20.0] },
          properties: {
            player: 'Target',
            distance: null,
            location: 'Somewhere',
          },
        },
      ],
    };
    assert.equal(
      formatTargetDiscord(positive, NOW),
      [
        '# Round 1, Somewhere, [20.00000°N 10.00000°E](https://www.google.com/maps/search/?api=1&query=20%2C10)',
        '[Submission Tracker](https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/001.geojson)',
        '[Rules](https://github.com/mlc/americas-tpg/blob/main/RULES.md)',
        EXPIRY_LINE,
      ].join('\n'),
    );
  });

  test('translates "Round" per roundInfo.language', () => {
    const cases: Array<[string, string]> = [
      ['es', 'Ronda'],
      ['pt', 'Rodada'],
      ['fr', 'Manche'],
      ['nl', 'Ronde'],
      ['ht', 'Tou'],
      ['en', 'Round'],
    ];
    for (const [language, word] of cases) {
      assert.match(
        formatTargetDiscord(buildRound(3, null, [], language), NOW),
        new RegExp(`^# ${word} 3,`),
      );
    }
  });

  test('unknown / missing language falls back to "Round"', () => {
    assert.match(
      formatTargetDiscord(buildRound(3, null, [], 'xx'), NOW),
      /^# Round 3,/,
    );
    assert.match(
      formatTargetDiscord(buildRound(3, null, []), NOW),
      /^# Round 3,/,
    );
  });

  test('output is exactly four lines: header, tracker, rules, expiry', () => {
    const out = formatTargetDiscord(buildRound(2, null, []), NOW);
    const lines = out.split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^# Round 2,/);
    assert.equal(lines[1], `[Submission Tracker](${submissionTrackerUrl(2)})`);
    assert.equal(lines[2], `[Rules](${RULES_URL})`);
    assert.equal(lines[3], EXPIRY_LINE);
  });

  test('rules link text is bilingual for non-English rounds', () => {
    const cases: Array<[string, string]> = [
      ['es', 'Rules / Reglas'],
      ['pt', 'Rules / Regras'],
      ['fr', 'Rules / Règles'],
      ['nl', 'Rules / Regels'],
      ['ht', 'Rules / Règ'],
    ];
    for (const [language, expected] of cases) {
      const out = formatTargetDiscord(buildRound(4, null, [], language), NOW);
      const rulesLine = out.split('\n')[2];
      assert.equal(rulesLine, `[${expected}](${RULES_URL})`);
    }
  });

  test('tracker link text is bilingual for non-English rounds', () => {
    const cases: Array<[string, string]> = [
      ['es', 'Submission Tracker / Rastreador de Envíos'],
      ['pt', 'Submission Tracker / Rastreador de Envios'],
      ['fr', 'Submission Tracker / Suivi des Soumissions'],
      ['nl', 'Submission Tracker / Inzendingen-tracker'],
      ['ht', 'Submission Tracker / Swivi Soumisyon'],
    ];
    for (const [language, expected] of cases) {
      const out = formatTargetDiscord(buildRound(4, null, [], language), NOW);
      const trackerLine = out.split('\n')[1];
      assert.equal(trackerLine, `[${expected}](${submissionTrackerUrl(4)})`);
    }
  });

  test('English / unknown / missing language uses plain "Rules" and "Submission Tracker" links', () => {
    for (const lang of ['en', 'xx', undefined]) {
      const out = formatTargetDiscord(buildRound(4, null, [], lang), NOW);
      const [, trackerLine, rulesLine] = out.split('\n');
      assert.equal(
        trackerLine,
        `[Submission Tracker](${submissionTrackerUrl(4)})`,
      );
      assert.equal(rulesLine, `[Rules](${RULES_URL})`);
    }
  });

  test('expiry line is the 4th line with a relative Discord timestamp for the next-day 21:00 NY epoch second', () => {
    const out = formatTargetDiscord(buildRound(5, null, []), NOW);
    const lines = out.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[3], `Submissions close <t:${EXPIRY_EPOCH}:R>`);
    // Sanity: matches the Discord <t:UNIX:R> grammar — integer seconds + :R.
    assert.match(lines[3], /^Submissions close <t:\d+:R>$/);
  });

  test('expiry line tracks the provided `now` — a different now produces a different epoch', () => {
    // One week later → expiry shifts by exactly 7 days = 604800 seconds.
    const later = NOW.plusSeconds(7 * 24 * 60 * 60);
    const expiryLater = formatTargetDiscord(
      buildRound(6, null, []),
      later,
    ).split('\n')[3];
    const expected = `Submissions close <t:${EXPIRY_EPOCH + 7 * 24 * 60 * 60}:R>`;
    assert.equal(expiryLater, expected);
  });

  test('defaults `now` to wall-clock when omitted — expiry is still well-formed and in the future', () => {
    const before = Math.floor(Date.now() / 1000);
    const out = formatTargetDiscord(buildRound(1, null, []));
    const after = Math.floor(Date.now() / 1000);
    const match = out.split('\n')[3].match(/^Submissions close <t:(\d+):R>$/);
    assert.ok(match, `expected expiry line, got: ${out.split('\n')[3]}`);
    const epoch = Number(match[1]);
    // Next-day 21:00 NY is always strictly in the future relative to "now",
    // and at most ~48h ahead (worst case: right after the prior day's 21:00).
    assert.ok(epoch > before, `expiry ${epoch} should be > now ${before}`);
    assert.ok(
      epoch < after + 48 * 60 * 60,
      `expiry ${epoch} should be < now + 48h (${after + 48 * 60 * 60})`,
    );
  });
});

describe('formatRoundResultDiscord', () => {
  test('single elimination → header / Unfortunately line / M players remain', () => {
    const round = buildRound(1, '2026-05-12T14:00:00Z', [
      submission('alice', 12.345),
      submission('bob', 45.678),
      submission('miss_inputs', 11554.284),
    ]);
    const message = formatRoundResultDiscord({
      round,
      eliminations: new Set(['miss_inputs']),
      dnsSet: new Set(),
      nextEligible: new Set(['alice', 'bob']),
      savedSet: new Set(),
      dnsChecks: [],
    });
    assert.equal(
      message,
      [
        '## Round 1 complete',
        'Unfortunately, @miss_inputs, at 11554.284km away, has been eliminated.',
        '2 players remain.',
      ].join('\n'),
    );
  });

  test('tied for last → both submitters mentioned with the lower distance', () => {
    const round = buildRound(2, '2026-05-13T14:00:00Z', [
      submission('alice', 10),
      submission('bob', 100.0),
      submission('carol', 100.02),
    ]);
    const message = formatRoundResultDiscord({
      round,
      eliminations: new Set(['bob', 'carol']),
      dnsSet: new Set(),
      nextEligible: new Set(['alice']),
      savedSet: new Set(),
      dnsChecks: [],
    });
    assert.match(
      message,
      /Unfortunately, @bob, @carol, tied for last within 25m at 100\.000km away, have been eliminated\./,
    );
    assert.match(message, /Game over! @alice wins!/);
  });

  test('DNS player → "did not submit" line, no distance', () => {
    const round = buildRound(2, '2026-05-13T14:00:00Z', [
      submission('alice', 10),
      submission('bob', 50),
    ]);
    const message = formatRoundResultDiscord({
      round,
      eliminations: new Set(['bob']),
      dnsSet: new Set(['carol']),
      nextEligible: new Set(['alice']),
      savedSet: new Set(),
      dnsChecks: [],
    });
    assert.equal(
      message,
      [
        '## Round 2 complete',
        'Unfortunately, @bob, at 50.000km away, has been eliminated.',
        'Unfortunately, @carol did not submit and has been eliminated.',
        'Game over! @alice wins!',
      ].join('\n'),
    );
  });

  test('stalemate → no-winner footer', () => {
    const round = buildRound(3, '2026-05-14T14:00:00Z', [
      submission('alice', 100.0),
      submission('bob', 100.01),
    ]);
    const message = formatRoundResultDiscord({
      round,
      eliminations: new Set(['alice', 'bob']),
      dnsSet: new Set(),
      nextEligible: new Set(),
      savedSet: new Set(),
      dnsChecks: [],
    });
    assert.match(message, /Game over: stalemate, no winner\./);
  });

  test('honest-DNS save → "saved by the honest-DNS rule" line names trigger and distance', () => {
    const round = buildRound(2, '2026-05-13T14:00:00Z', [
      submission('alice', 50),
      submission('bob', 100),
    ]);
    const message = formatRoundResultDiscord({
      round,
      eliminations: new Set(),
      dnsSet: new Set(['carol']),
      nextEligible: new Set(['alice', 'bob']),
      savedSet: new Set(['bob']),
      dnsChecks: [
        {
          player: 'carol',
          best: { point: [-67.5, -42.5], distanceKm: 25.0 },
          couldHaveEscaped: false,
          morphiorDbStatus: 'ok',
          morphiorDbSubmissionCount: 3,
        },
      ],
    });
    assert.equal(
      message,
      [
        '## Round 2 complete',
        'Unfortunately, @carol did not submit and has been eliminated.',
        "@bob was saved by the honest-DNS rule (triggered by @carol's best historical at 25.000km).",
        '2 players remain.',
      ].join('\n'),
    );
  });
});

describe('roundExpiry', () => {
  test('returns next-day 21:00 in New York (EDT case, May)', () => {
    // 2026-05-12T14:00:00Z → next-day 21:00 NY (EDT, UTC-4) = 2026-05-14T01:00:00Z.
    const expiry = roundExpiry(Instant.parse('2026-05-12T14:00:00Z'));
    assert.equal(expiry.toString(), '2026-05-14T01:00:00Z');
  });

  test('returns next-day 21:00 in New York (EST case, January)', () => {
    // 2026-01-15T14:00:00Z → next-day 21:00 NY (EST, UTC-5) = 2026-01-17T02:00:00Z.
    const expiry = roundExpiry(Instant.parse('2026-01-15T14:00:00Z'));
    assert.equal(expiry.toString(), '2026-01-17T02:00:00Z');
  });

  test('crosses spring-forward DST boundary cleanly', () => {
    // 2026 US DST begins 2026-03-08 (clocks jump from 02:00 EST → 03:00 EDT).
    // "now" the morning before → next-day 21:00 NY lands AFTER the transition,
    // so the resulting instant uses the EDT offset (UTC-4), not EST.
    const expiry = roundExpiry(Instant.parse('2026-03-07T14:00:00Z'));
    assert.equal(expiry.toString(), '2026-03-09T01:00:00Z');
  });

  test('crosses fall-back DST boundary cleanly', () => {
    // 2026 US DST ends 2026-11-01 (clocks fall back from 02:00 EDT → 01:00 EST).
    // "now" the morning before → next-day 21:00 NY lands AFTER the transition,
    // so the resulting instant uses the EST offset (UTC-5).
    const expiry = roundExpiry(Instant.parse('2026-10-31T14:00:00Z'));
    assert.equal(expiry.toString(), '2026-11-02T02:00:00Z');
  });

  test('late-evening "now" past 21:00 NY still rolls to the NEXT day, not the same day', () => {
    // 2026-05-12T23:00:00Z = 2026-05-12T19:00 EDT. Naively "21:00 today" would
    // be just 2 hours away, but roundExpiry always adds a day first, so the
    // result is 2026-05-13T21:00 EDT = 2026-05-14T01:00:00Z (~26 hours out).
    const expiry = roundExpiry(Instant.parse('2026-05-12T23:00:00Z'));
    assert.equal(expiry.toString(), '2026-05-14T01:00:00Z');
  });

  test('"now" before midnight UTC but already next-day in NY rolls relative to NY date, not UTC date', () => {
    // 2026-05-13T01:00:00Z = 2026-05-12T21:00 EDT. NY calendar date is still
    // May 12, so next-day 21:00 NY = 2026-05-13T21:00 EDT = 2026-05-14T01:00:00Z.
    const expiry = roundExpiry(Instant.parse('2026-05-13T01:00:00Z'));
    assert.equal(expiry.toString(), '2026-05-14T01:00:00Z');
  });

  test('default `now` (omitted) returns an instant strictly in the future', () => {
    const before = Instant.now();
    const expiry = roundExpiry();
    assert.ok(
      expiry.isAfter(before),
      `expiry ${expiry} should be after now ${before}`,
    );
  });
});

describe('submitters / eliminationsForRound', () => {
  test('submitters returns player names in feature order', () => {
    const round = buildRound(1, null, [
      submission('alice', 10),
      submission('bob', 20),
      submission('carol', 30),
    ]);
    assert.deepEqual(submitters(round), ['alice', 'bob', 'carol']);
  });

  test('eliminationsForRound: only the farthest when no ties (R12)', () => {
    const round = buildRound(1, null, [
      submission('alice', 10),
      submission('bob', 20),
      submission('carol', 30),
    ]);
    assert.deepEqual([...eliminationsForRound(round)], ['carol']);
  });

  test('eliminationsForRound: all within 25 m of farthest are tied (AE4 / R13)', () => {
    const round = buildRound(1, null, [
      submission('alice', 10),
      submission('bob', 100.0),
      submission('carol', 100.02),
    ]);
    assert.deepEqual([...eliminationsForRound(round)].sort(), ['bob', 'carol']);
  });

  test('eliminationsForRound: 25 m exactly is NOT tied (strict < buffer)', () => {
    const round = buildRound(1, null, [
      submission('alice', 100 - TIE_BUFFER_KM), // exactly 25 m closer
      submission('bob', 100),
    ]);
    assert.deepEqual([...eliminationsForRound(round)], ['bob']);
  });

  test('eliminationsForRound: 24.999 m closer IS tied (within buffer)', () => {
    const round = buildRound(1, null, [
      submission('alice', 100 - 0.024999), // 24.999 m closer than bob
      submission('bob', 100),
    ]);
    assert.deepEqual([...eliminationsForRound(round)].sort(), ['alice', 'bob']);
  });

  test('eliminationsForRound: zero submissions → empty set', () => {
    const round = buildRound(1, null, []);
    assert.equal(eliminationsForRound(round).size, 0);
  });

  test('eliminationsForRound: everyone within 25 m → all eliminated (AE6)', () => {
    const round = buildRound(1, null, [
      submission('alice', 100.0),
      submission('bob', 100.01),
      submission('carol', 100.02),
    ]);
    assert.deepEqual([...eliminationsForRound(round)].sort(), [
      'alice',
      'bob',
      'carol',
    ]);
  });
});

describe('validateSubmissionEligibility', () => {
  test('round 1 (prevRound null) → eligible for any name (R6)', () => {
    const r1 = buildRound(1, null, []);
    assert.deepEqual(
      validateSubmissionEligibility({
        player: 'alice',
        currentRound: r1,
        currentRoundNumber: 1,
        prevRound: null,
      }),
      { eligible: true },
    );
    assert.deepEqual(
      validateSubmissionEligibility({
        player: 'newcomer',
        currentRound: r1,
        currentRoundNumber: 1,
        prevRound: null,
      }),
      { eligible: true },
    );
  });

  test('round 2 with player not in eligible-set → ineligible (R7 / AE3)', () => {
    const r1 = buildRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [submission('alice', 10), submission('bob', 20), submission('dan', 30)],
        ['dan'],
      ),
    );
    const r2 = buildRound(2, null, []);
    const result = validateSubmissionEligibility({
      player: 'dan',
      currentRound: r2,
      currentRoundNumber: 2,
      prevRound: r1,
    });
    assert.equal(result.eligible, false);
    assert.match(result.reason ?? '', /not eligible for round 2/);
    assert.match(result.reason ?? '', /Eligible: alice, bob/);
  });

  test('round 2 with surviving player → eligible', () => {
    const r1 = buildRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [submission('alice', 10), submission('bob', 20), submission('dan', 30)],
        ['dan'],
      ),
    );
    const r2 = buildRound(2, null, []);
    assert.deepEqual(
      validateSubmissionEligibility({
        player: 'alice',
        currentRound: r2,
        currentRoundNumber: 2,
        prevRound: r1,
      }),
      { eligible: true },
    );
  });

  test('eligibility consults persisted `eliminated` field, not recomputed distances', () => {
    // The "true" farthest is dan (distance 30), but we mark alice eliminated
    // and dan a survivor. validateSubmissionEligibility should trust the
    // persisted booleans.
    const r1 = buildRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [submission('alice', 10), submission('bob', 20), submission('dan', 30)],
        ['alice'],
      ),
    );
    const r2 = buildRound(2, null, []);
    assert.equal(
      validateSubmissionEligibility({
        player: 'alice',
        currentRound: r2,
        currentRoundNumber: 2,
        prevRound: r1,
      }).eligible,
      false,
      'alice was persisted as eliminated → ineligible regardless of distance',
    );
    assert.equal(
      validateSubmissionEligibility({
        player: 'dan',
        currentRound: r2,
        currentRoundNumber: 2,
        prevRound: r1,
      }).eligible,
      true,
      'dan was persisted as survivor → eligible regardless of distance',
    );
  });

  test('current round already ended → ineligible (R11)', () => {
    const r1 = buildRound(1, '2026-05-06T12:00:00Z', [submission('alice', 10)]);
    const result = validateSubmissionEligibility({
      player: 'alice',
      currentRound: r1,
      currentRoundNumber: 1,
      prevRound: null,
    });
    assert.equal(result.eligible, false);
    assert.match(result.reason ?? '', /round 1 is ended/);
  });
});

describe('formatStandings', () => {
  test('sorted ascending by distance with km formatting', () => {
    const round = buildRound(1, null, [
      submission('carol', 30.5),
      submission('alice', 10.123),
      submission('bob', 20.7),
    ]);
    assert.equal(
      formatStandings(round),
      [
        'Standings:',
        '   1. alice  10.123 km',
        '   2. bob  20.700 km',
        '   3. carol  30.500 km',
      ].join('\n'),
    );
  });

  test('zero submissions → "(no submissions)"', () => {
    const round = buildRound(1, null, []);
    assert.equal(formatStandings(round), 'Standings:\n  (no submissions)');
  });
});

describe('evaluateDnsCheck', () => {
  // Fixed reference target near (0, 0); points further away in km are easy
  // to reason about with the tiny-Earth approximation @turf/distance gives.
  const TARGET: [number, number] = [0, 0];

  test('empty points → best null + couldHaveEscaped true (anti-ghost)', () => {
    const result = evaluateDnsCheck(TARGET, [], 100);
    assert.equal(result.best, null);
    assert.equal(result.couldHaveEscaped, true);
  });

  test('best point is far from target (worse than currentMax) → couldHaveEscaped false (honest DNS)', () => {
    // Point ~111 km away (1 degree latitude at the equator).
    const result = evaluateDnsCheck(TARGET, [[0, 1]], 50);
    assert.equal(result.couldHaveEscaped, false);
    assert.ok(result.best !== null);
    assert.deepEqual(result.best.point, [0, 1]);
    assert.ok(result.best.distanceKm > 100);
  });

  test('bestDistance just under (currentMax − TIE_BUFFER_KM) → couldHaveEscaped true', () => {
    // Point 50 km from target; cutoff = 75; 50 < 75 − 0.025 = 74.975 → escapes.
    const result = evaluateDnsCheck(TARGET, [[0, 50 / 111.195]], 75);
    assert.equal(result.couldHaveEscaped, true);
  });

  test('bestDistance at the boundary (currentMax − TIE_BUFFER_KM) → couldHaveEscaped false (strict <)', () => {
    // Pick currentMax = bestDistance + TIE_BUFFER_KM exactly; strict < says false.
    const point: [number, number] = [0, 0.5]; // ~55.6 km
    const evalResult = evaluateDnsCheck(TARGET, [point], 0);
    assert.ok(evalResult.best !== null);
    const bestKm = evalResult.best.distanceKm;
    const result = evaluateDnsCheck(TARGET, [point], bestKm + TIE_BUFFER_KM);
    assert.equal(result.couldHaveEscaped, false);
  });

  test('bestDistance just under the boundary (boundary − ε) → couldHaveEscaped true', () => {
    const point: [number, number] = [0, 0.5];
    const evalResult = evaluateDnsCheck(TARGET, [point], 0);
    assert.ok(evalResult.best !== null);
    const bestKm = evalResult.best.distanceKm;
    // currentMax = bestKm + TIE_BUFFER_KM + epsilon → bestKm < currentMax − buffer.
    const result = evaluateDnsCheck(
      TARGET,
      [point],
      bestKm + TIE_BUFFER_KM + 0.0001,
    );
    assert.equal(result.couldHaveEscaped, true);
  });

  test('best.point reports the closest point when multiple are provided', () => {
    const far: [number, number] = [10, 10];
    const close: [number, number] = [0, 0.001];
    const result = evaluateDnsCheck(TARGET, [far, close, far], 100);
    assert.ok(result.best !== null);
    assert.deepEqual(result.best.point, close);
    assert.ok(result.best.distanceKm < 1);
    assert.equal(result.couldHaveEscaped, true);
  });

  test('point sub-meter from target → couldHaveEscaped true', () => {
    // 0.000001 deg ≈ 0.11 m from origin.
    const result = evaluateDnsCheck(TARGET, [[0.000001, 0]], 0.5);
    assert.equal(result.couldHaveEscaped, true);
  });
});
