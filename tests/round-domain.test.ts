import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  eligibleForNextRound,
  eliminationsForRound,
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

function makeTarget(ended_at: string | null = null): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: { location: 'Río Negro, Argentina', ended_at },
  };
}

const target = makeTarget();

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
  _round: number,
  ended_at: string | null,
  subs: SubmissionFeature[],
): RoundFile {
  return {
    type: 'FeatureCollection',
    features: [makeTarget(ended_at), ...subs],
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
      formatTargetDiscord(7, target),
      '# Round 7, Río Negro, Argentina, [42.50000°S 67.50000°W](https://www.google.com/maps/search/?api=1&query=-42.5%2C-67.5)',
    );
  });

  test('positive lat/lng renders N/E and unsigned URL coords', () => {
    const positive: TargetFeature = {
      type: 'Feature',
      id: 'target',
      geometry: { type: 'Point', coordinates: [10.0, 20.0] },
      properties: { location: 'Somewhere', ended_at: null },
    };
    assert.equal(
      formatTargetDiscord(1, positive),
      '# Round 1, Somewhere, [20.00000°N 10.00000°E](https://www.google.com/maps/search/?api=1&query=20%2C10)',
    );
  });

  test('translates "Round" per target.properties.language', () => {
    const cases: Array<[string, string]> = [
      ['es', 'Ronda'],
      ['pt', 'Rodada'],
      ['fr', 'Manche'],
      ['nl', 'Ronde'],
      ['ht', 'Tou'],
      ['en', 'Round'],
    ];
    for (const [language, word] of cases) {
      const feature: TargetFeature = {
        type: 'Feature',
        id: 'target',
        geometry: { type: 'Point', coordinates: [10, 20] },
        properties: { location: 'Somewhere', ended_at: null, language },
      };
      assert.match(
        formatTargetDiscord(3, feature),
        new RegExp(`^# ${word} 3,`),
      );
    }
  });

  test('unknown / missing language falls back to "Round"', () => {
    const unknown: TargetFeature = {
      type: 'Feature',
      id: 'target',
      geometry: { type: 'Point', coordinates: [10, 20] },
      properties: { location: 'Somewhere', ended_at: null, language: 'xx' },
    };
    assert.match(formatTargetDiscord(3, unknown), /^# Round 3,/);
  });
});

describe('submitters / eliminationsForRound / eligibleForNextRound', () => {
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

  test('eligibleForNextRound: submitters minus eliminations (AE1 setup)', () => {
    const round = buildRound(1, null, [
      submission('alice', 10),
      submission('bob', 20),
      submission('carol', 30),
    ]);
    assert.deepEqual([...eligibleForNextRound(round)].sort(), ['alice', 'bob']);
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
    const r1 = buildRound(1, '2026-05-06T12:00:00Z', [
      submission('alice', 10),
      submission('bob', 20),
      submission('dan', 30),
    ]);
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
    const r1 = buildRound(1, '2026-05-06T12:00:00Z', [
      submission('alice', 10),
      submission('bob', 20),
      submission('dan', 30),
    ]);
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
