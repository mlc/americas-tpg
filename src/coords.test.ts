import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeCoord } from './coords.ts';

function approxEqual(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected} (within ${eps})`,
  );
}

describe('decodeCoord — decimal forms', () => {
  test('comma-separated lat,lng', () => {
    const p = decodeCoord('40.7128, -74.0060');
    assert.equal(p.type, 'Point');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('space-separated lat lng', () => {
    const p = decodeCoord('40.7128 -74.0060');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('comma without surrounding space', () => {
    const p = decodeCoord('40.7128,-74.0060');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('extra whitespace around input is tolerated', () => {
    const p = decodeCoord('   40.7128 ,  -74.0060   ');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('negative southern/western decimals', () => {
    const p = decodeCoord('-42.5, -67.5');
    approxEqual(p.coordinates[0], -67.5);
    approxEqual(p.coordinates[1], -42.5);
  });

  test('output is a GeoJSON Point with [lon, lat] ordering', () => {
    const p = decodeCoord('10, 20');
    assert.deepEqual(p, { type: 'Point', coordinates: [20, 10] });
  });
});

describe('decodeCoord — hemisphere suffixes', () => {
  test('NESW with degree symbol', () => {
    const p = decodeCoord('40.7128°N 74.0060°W');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('NESW without degree symbol', () => {
    const p = decodeCoord('40.7128N 74.0060W');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });

  test('southern/western hemisphere via S/W', () => {
    const p = decodeCoord('42.5S 67.5W');
    approxEqual(p.coordinates[0], -67.5);
    approxEqual(p.coordinates[1], -42.5);
  });

  test('lowercase hemisphere letters are accepted (regex is /i)', () => {
    const p = decodeCoord('42.5s 67.5w');
    approxEqual(p.coordinates[0], -67.5);
    approxEqual(p.coordinates[1], -42.5);
  });

  test('space between number and hemisphere is collapsed before parsing', () => {
    // The leading-space-before-N/E/S/W replacement is what makes this work.
    const p = decodeCoord('40.7128 N 74.0060 W');
    approxEqual(p.coordinates[0], -74.006);
    approxEqual(p.coordinates[1], 40.7128);
  });
});

describe('decodeCoord — DMS forms', () => {
  test('colon-separated D:M:S with hemisphere', () => {
    const p = decodeCoord('40:42:46N 74:00:21W');
    approxEqual(p.coordinates[1], 40 + 42 / 60 + 46 / 3600, 1e-9);
    approxEqual(p.coordinates[0], -(74 + 0 / 60 + 21 / 3600), 1e-9);
  });

  test('d/’/”-style DMS with hemisphere', () => {
    const p = decodeCoord(`40d42'46"N 74d00'21"W`);
    approxEqual(p.coordinates[1], 40 + 42 / 60 + 46 / 3600, 1e-9);
    approxEqual(p.coordinates[0], -(74 + 0 / 60 + 21 / 3600), 1e-9);
  });
});

describe('decodeCoord — error cases', () => {
  test('empty string → unable to parse', () => {
    assert.throws(() => decodeCoord(''), /unable to parse/);
  });

  test('single token → unable to parse', () => {
    assert.throws(() => decodeCoord('40.5'), /unable to parse/);
  });

  test('three tokens → unable to parse', () => {
    assert.throws(() => decodeCoord('40.5, 30, 20'), /unable to parse/);
  });

  test('non-numeric garbage → DMS lib rejects', () => {
    assert.throws(() => decodeCoord('foo bar'));
  });

  test('latitude out of [-90, 90] → DMS lib rejects with range error', () => {
    assert.throws(() => decodeCoord('91, 0'), /Latitude .* not in/);
  });
});
