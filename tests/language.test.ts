import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GID0_TO_ISO639_1,
  GID0_TO_LOCAL_NAME,
  mainLanguageOf,
  ROUND_LABEL,
  roundLabel,
} from '../src/language.ts';

describe('language tables — internal consistency', () => {
  test('GID0_TO_ISO639_1 and GID0_TO_LOCAL_NAME cover the same set of GIDs', () => {
    const langKeys = Object.keys(GID0_TO_ISO639_1).sort();
    const nameKeys = Object.keys(GID0_TO_LOCAL_NAME).sort();
    assert.deepEqual(
      langKeys,
      nameKeys,
      'every GID with a language must have a localized name, and vice versa',
    );
  });

  test('every language in GID0_TO_ISO639_1 has a ROUND_LABEL entry', () => {
    const languages = new Set(Object.values(GID0_TO_ISO639_1));
    const labelled = new Set(Object.keys(ROUND_LABEL));
    const missing = [...languages].filter((l) => !labelled.has(l));
    assert.deepEqual(
      missing,
      [],
      `languages missing from ROUND_LABEL: ${missing.join(', ')}`,
    );
  });
});

describe('roundLabel', () => {
  test('returns the translation when known', () => {
    assert.equal(roundLabel('es'), 'Ronda');
    assert.equal(roundLabel('pt'), 'Rodada');
    assert.equal(roundLabel('fr'), 'Manche');
  });

  test('falls back to "Round" for undefined, empty string, or unknown', () => {
    assert.equal(roundLabel(undefined), 'Round');
    assert.equal(roundLabel(''), 'Round');
    assert.equal(roundLabel('xx'), 'Round');
  });
});

describe('mainLanguageOf', () => {
  test('returns ISO 639-1 code for known GIDs', () => {
    assert.equal(mainLanguageOf('BRA'), 'pt');
    assert.equal(mainLanguageOf('HTI'), 'ht');
    assert.equal(mainLanguageOf('ARG'), 'es');
  });

  test('returns undefined for unknown / missing GID', () => {
    assert.equal(mainLanguageOf(undefined), undefined);
    assert.equal(mainLanguageOf(''), undefined);
    assert.equal(mainLanguageOf('XYZ'), undefined);
  });
});
