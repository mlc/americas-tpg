import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRng, RNG_NAMES, rngFactories } from '../src/rng.ts';

describe('cryptoRandom', () => {
  test('returns numbers in [0, 1)', async () => {
    const rng = createRng('crypto');
    for (let i = 0; i < 200; i++) {
      const v = await rng.next();
      assert.equal(typeof v, 'number');
      assert.ok(Number.isFinite(v), 'finite');
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  test('produces distinct values across calls (overwhelmingly likely)', async () => {
    const rng = createRng('crypto');
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) values.add(await rng.next());
    // 100 independent draws of a 2^53-bucket distribution colliding is
    // astronomically improbable; fewer than 100 unique => bug.
    assert.equal(values.size, 100);
  });

  test('mean of many samples is roughly 0.5', async () => {
    const rng = createRng('crypto');
    const N = 5000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += await rng.next();
    const mean = sum / N;
    assert.ok(
      Math.abs(mean - 0.5) < 0.05,
      `mean ${mean} not within 0.05 of 0.5`,
    );
  });
});

describe('mathRandom', () => {
  test('returns numbers in [0, 1)', async () => {
    const rng = createRng('math');
    for (let i = 0; i < 200; i++) {
      const v = await rng.next();
      assert.equal(typeof v, 'number');
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe('rngFactories / RNG_NAMES / createRng', () => {
  test('RNG_NAMES contains the three known sources', () => {
    assert.deepEqual([...RNG_NAMES].sort(), ['crypto', 'math', 'random.org']);
  });

  test('every name has a factory', () => {
    for (const name of RNG_NAMES) {
      const rng = rngFactories[name]();
      assert.equal(typeof rng.next, 'function');
    }
  });

  test('createRng returns an independent instance per call (random.org buffers separately)', () => {
    const a = createRng('random.org');
    const b = createRng('random.org');
    assert.notEqual(a, b, 'each createRng call should yield a fresh instance');
  });
});
