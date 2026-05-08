import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  RoundFile,
  SubmissionFeature,
  TargetFeature,
} from '../src/round-domain.ts';
import {
  applySimplestyle,
  playerMarkerColor,
  SIMPLESTYLE,
} from '../src/simplestyle.ts';

const target: TargetFeature = {
  type: 'Feature',
  id: 'target',
  geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
  properties: { location: 'Río Negro, Argentina', ended_at: null },
};

function submission(player: string, distance: number): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { player, distance },
  };
}

function makeRound(subs: SubmissionFeature[]): RoundFile {
  return {
    type: 'FeatureCollection',
    features: [target, ...subs],
  };
}

type SimplestyleProps = {
  'marker-symbol'?: string;
  'marker-color'?: string;
};

function styleOf(feature: {
  properties: Record<string, unknown>;
}): SimplestyleProps {
  return {
    'marker-symbol': feature.properties['marker-symbol'] as string | undefined,
    'marker-color': feature.properties['marker-color'] as string | undefined,
  };
}

describe('playerMarkerColor', () => {
  test('last-place wins over any podium rank', () => {
    assert.equal(playerMarkerColor(0, true), SIMPLESTYLE.LAST);
    assert.equal(playerMarkerColor(1, true), SIMPLESTYLE.LAST);
    assert.equal(playerMarkerColor(2, true), SIMPLESTYLE.LAST);
    assert.equal(playerMarkerColor(99, true), SIMPLESTYLE.LAST);
  });

  test('podium ranks 0/1/2 → gold/silver/bronze', () => {
    assert.equal(playerMarkerColor(0, false), SIMPLESTYLE.GOLD);
    assert.equal(playerMarkerColor(1, false), SIMPLESTYLE.SILVER);
    assert.equal(playerMarkerColor(2, false), SIMPLESTYLE.BRONZE);
  });

  test('rank 3+ falls back to default gray', () => {
    assert.equal(playerMarkerColor(3, false), SIMPLESTYLE.DEFAULT_PLAYER);
    assert.equal(playerMarkerColor(99, false), SIMPLESTYLE.DEFAULT_PLAYER);
  });
});

describe('applySimplestyle — target marker', () => {
  test('always star + black, regardless of submissions', () => {
    const styled = applySimplestyle(makeRound([]));
    assert.deepEqual(styleOf(styled.features[0]), {
      'marker-symbol': 'star',
      'marker-color': '#000000',
    });
  });

  test('preserves the existing target properties (location etc.)', () => {
    const styled = applySimplestyle(makeRound([]));
    assert.equal(
      (styled.features[0].properties as Record<string, unknown>).location,
      'Río Negro, Argentina',
    );
    assert.equal((styled.features[0] as { id?: string }).id, 'target');
  });

  test('overwrites stale styling (recomputes from scratch)', () => {
    const stale: RoundFile = makeRound([]);
    // Pretend a prior write stored the wrong styling.
    (stale.features[0].properties as Record<string, unknown>)['marker-color'] =
      '#abcdef';
    const styled = applySimplestyle(stale);
    assert.equal(
      (styled.features[0].properties as Record<string, unknown>)[
        'marker-color'
      ],
      '#000000',
    );
  });
});

describe('applySimplestyle — player marker symbols', () => {
  test('every submission is a circle', () => {
    const round = makeRound([
      submission('alice', 10),
      submission('bob', 20),
      submission('carol', 30),
    ]);
    const styled = applySimplestyle(round);
    for (let i = 1; i < styled.features.length; i++) {
      assert.equal(styleOf(styled.features[i])['marker-symbol'], 'circle');
    }
  });
});

describe('applySimplestyle — color assignment by rank and last-place tie', () => {
  test('three untied players → gold/silver, last (3rd) is red (not bronze)', () => {
    const styled = applySimplestyle(
      makeRound([
        submission('alice', 10),
        submission('bob', 20),
        submission('carol', 30),
      ]),
    );
    const byPlayer = new Map(
      styled.features
        .slice(1)
        .map((f) => [
          (f.properties as { player: string }).player,
          styleOf(f)['marker-color'],
        ]),
    );
    assert.equal(byPlayer.get('alice'), SIMPLESTYLE.GOLD);
    assert.equal(byPlayer.get('bob'), SIMPLESTYLE.SILVER);
    assert.equal(byPlayer.get('carol'), SIMPLESTYLE.LAST);
  });

  test('four untied players → gold/silver/bronze, last is red', () => {
    const styled = applySimplestyle(
      makeRound([
        submission('alice', 10),
        submission('bob', 20),
        submission('carol', 30),
        submission('dan', 40),
      ]),
    );
    const byPlayer = new Map(
      styled.features
        .slice(1)
        .map((f) => [
          (f.properties as { player: string }).player,
          styleOf(f)['marker-color'],
        ]),
    );
    assert.equal(byPlayer.get('alice'), SIMPLESTYLE.GOLD);
    assert.equal(byPlayer.get('bob'), SIMPLESTYLE.SILVER);
    assert.equal(byPlayer.get('carol'), SIMPLESTYLE.BRONZE);
    assert.equal(byPlayer.get('dan'), SIMPLESTYLE.LAST);
  });

  test('five untied players → 5th and 4th gray, podium intact', () => {
    const styled = applySimplestyle(
      makeRound([
        submission('alice', 10),
        submission('bob', 20),
        submission('carol', 30),
        submission('dan', 40),
        submission('eve', 50),
      ]),
    );
    const byPlayer = new Map(
      styled.features
        .slice(1)
        .map((f) => [
          (f.properties as { player: string }).player,
          styleOf(f)['marker-color'],
        ]),
    );
    assert.equal(byPlayer.get('alice'), SIMPLESTYLE.GOLD);
    assert.equal(byPlayer.get('bob'), SIMPLESTYLE.SILVER);
    assert.equal(byPlayer.get('carol'), SIMPLESTYLE.BRONZE);
    assert.equal(byPlayer.get('dan'), SIMPLESTYLE.DEFAULT_PLAYER);
    assert.equal(byPlayer.get('eve'), SIMPLESTYLE.LAST);
  });

  test('sole submitter → red (last) wins over gold (1st)', () => {
    const styled = applySimplestyle(makeRound([submission('alice', 5)]));
    assert.equal(styleOf(styled.features[1])['marker-color'], SIMPLESTYLE.LAST);
  });

  test('all players within 25 m of each other → everyone is red', () => {
    const styled = applySimplestyle(
      makeRound([
        submission('alice', 100.0),
        submission('bob', 100.01),
        submission('carol', 100.02),
      ]),
    );
    for (let i = 1; i < styled.features.length; i++) {
      assert.equal(
        styleOf(styled.features[i])['marker-color'],
        SIMPLESTYLE.LAST,
      );
    }
  });

  test('tie at the back (within 25 m of farthest) → both tied players red, podium unaffected', () => {
    const styled = applySimplestyle(
      makeRound([
        submission('alice', 10),
        submission('bob', 20),
        submission('carol', 100.0),
        submission('dan', 100.02),
      ]),
    );
    const byPlayer = new Map(
      styled.features
        .slice(1)
        .map((f) => [
          (f.properties as { player: string }).player,
          styleOf(f)['marker-color'],
        ]),
    );
    assert.equal(byPlayer.get('alice'), SIMPLESTYLE.GOLD);
    assert.equal(byPlayer.get('bob'), SIMPLESTYLE.SILVER);
    assert.equal(byPlayer.get('carol'), SIMPLESTYLE.LAST);
    assert.equal(byPlayer.get('dan'), SIMPLESTYLE.LAST);
  });

  test('zero submissions → only the styled target survives', () => {
    const styled = applySimplestyle(makeRound([]));
    assert.equal(styled.features.length, 1);
    assert.equal(styleOf(styled.features[0])['marker-symbol'], 'star');
  });
});

describe('applySimplestyle — purity & idempotency', () => {
  test('does not mutate the input round or its features', () => {
    const round = makeRound([submission('alice', 10), submission('bob', 20)]);
    const beforeJson = JSON.stringify(round);
    applySimplestyle(round);
    assert.equal(JSON.stringify(round), beforeJson);
  });

  test('applying twice yields the same output as applying once', () => {
    const round = makeRound([
      submission('alice', 10),
      submission('bob', 20),
      submission('carol', 30),
    ]);
    const once = applySimplestyle(round);
    const twice = applySimplestyle(once);
    assert.equal(JSON.stringify(twice), JSON.stringify(once));
  });
});
