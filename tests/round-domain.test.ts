import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  eliminationsForRound,
  evaluateDnsCheck,
  formatLocation,
  formatStandings,
  formatTargetDiscord,
  type RoundFile,
  type SubmissionFeature,
  submitters,
  type TargetFeature,
  TIE_BUFFER_KM,
  validateSubmissionEligibility,
} from '../src/round-domain.ts';
import { withEliminated } from './test-helpers.ts';

function makeTarget(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: { location: 'Río Negro, Argentina' },
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

describe('formatTargetDiscord', () => {
  test('renders Discord markdown with round, location, and Google Maps link', () => {
    assert.equal(
      formatTargetDiscord(buildRound(7, null, [])),
      '# Round 7, Río Negro, Argentina, [42.50000°S 67.50000°W](https://www.google.com/maps/search/?api=1&query=-42.5%2C-67.5)',
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
          properties: { location: 'Somewhere' },
        },
      ],
    };
    assert.equal(
      formatTargetDiscord(positive),
      '# Round 1, Somewhere, [20.00000°N 10.00000°E](https://www.google.com/maps/search/?api=1&query=20%2C10)',
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
        formatTargetDiscord(buildRound(3, null, [], language)),
        new RegExp(`^# ${word} 3,`),
      );
    }
  });

  test('unknown / missing language falls back to "Round"', () => {
    assert.match(
      formatTargetDiscord(buildRound(3, null, [], 'xx')),
      /^# Round 3,/,
    );
    assert.match(formatTargetDiscord(buildRound(3, null, [])), /^# Round 3,/);
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

  test('empty points → bestPoint null + couldHaveEscaped true (anti-ghost)', () => {
    const result = evaluateDnsCheck(TARGET, [], 100);
    assert.equal(result.bestPoint, null);
    assert.equal(result.bestDistanceKm, null);
    assert.equal(result.couldHaveEscaped, true);
  });

  test('best point is far from target (worse than currentMax) → couldHaveEscaped false (honest DNS)', () => {
    // Point ~111 km away (1 degree latitude at the equator).
    const result = evaluateDnsCheck(TARGET, [[0, 1]], 50);
    assert.equal(result.couldHaveEscaped, false);
    assert.deepEqual(result.bestPoint, [0, 1]);
    assert.ok(result.bestDistanceKm !== null && result.bestDistanceKm > 100);
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
    const bestKm = evalResult.bestDistanceKm;
    assert.ok(bestKm !== null);
    const result = evaluateDnsCheck(TARGET, [point], bestKm + TIE_BUFFER_KM);
    assert.equal(result.couldHaveEscaped, false);
  });

  test('bestDistance just under the boundary (boundary − ε) → couldHaveEscaped true', () => {
    const point: [number, number] = [0, 0.5];
    const evalResult = evaluateDnsCheck(TARGET, [point], 0);
    const bestKm = evalResult.bestDistanceKm;
    assert.ok(bestKm !== null);
    // currentMax = bestKm + TIE_BUFFER_KM + epsilon → bestKm < currentMax − buffer.
    const result = evaluateDnsCheck(
      TARGET,
      [point],
      bestKm + TIE_BUFFER_KM + 0.0001,
    );
    assert.equal(result.couldHaveEscaped, true);
  });

  test('bestPoint reports the closest point when multiple are provided', () => {
    const far: [number, number] = [10, 10];
    const close: [number, number] = [0, 0.001];
    const result = evaluateDnsCheck(TARGET, [far, close, far], 100);
    assert.deepEqual(result.bestPoint, close);
    assert.ok(result.bestDistanceKm !== null && result.bestDistanceKm < 1);
    assert.equal(result.couldHaveEscaped, true);
  });

  test('point sub-meter from target → couldHaveEscaped true', () => {
    // 0.000001 deg ≈ 0.11 m from origin.
    const result = evaluateDnsCheck(TARGET, [[0.000001, 0]], 0.5);
    assert.equal(result.couldHaveEscaped, true);
  });
});
