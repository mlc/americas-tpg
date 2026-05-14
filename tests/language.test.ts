import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GID0_TO_ISO639_1,
  GID0_TO_LOCAL_NAME,
  LEADERBOARD_LABEL,
  leaderboardLinkText,
  mainLanguageOf,
  ROUND_LABEL,
  RULES_LABEL,
  roundLabel,
  rulesLinkText,
  SUBMISSION_TRACKER_LABEL,
  submissionTrackerLinkText,
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

  test('every language in GID0_TO_ISO639_1 has a RULES_LABEL entry', () => {
    const languages = new Set(Object.values(GID0_TO_ISO639_1));
    const labelled = new Set(Object.keys(RULES_LABEL));
    const missing = [...languages].filter((l) => !labelled.has(l));
    assert.deepEqual(
      missing,
      [],
      `languages missing from RULES_LABEL: ${missing.join(', ')}`,
    );
  });

  test('every language in GID0_TO_ISO639_1 has a SUBMISSION_TRACKER_LABEL entry', () => {
    const languages = new Set(Object.values(GID0_TO_ISO639_1));
    const labelled = new Set(Object.keys(SUBMISSION_TRACKER_LABEL));
    const missing = [...languages].filter((l) => !labelled.has(l));
    assert.deepEqual(
      missing,
      [],
      `languages missing from SUBMISSION_TRACKER_LABEL: ${missing.join(', ')}`,
    );
  });

  test('every language in GID0_TO_ISO639_1 has a LEADERBOARD_LABEL entry', () => {
    const languages = new Set(Object.values(GID0_TO_ISO639_1));
    const labelled = new Set(Object.keys(LEADERBOARD_LABEL));
    const missing = [...languages].filter((l) => !labelled.has(l));
    assert.deepEqual(
      missing,
      [],
      `languages missing from LEADERBOARD_LABEL: ${missing.join(', ')}`,
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

describe('rulesLinkText', () => {
  test('returns plain "Rules" for English / undefined / unknown', () => {
    assert.equal(rulesLinkText(undefined), 'Rules');
    assert.equal(rulesLinkText(''), 'Rules');
    assert.equal(rulesLinkText('en'), 'Rules');
    assert.equal(rulesLinkText('xx'), 'Rules');
  });

  test('appends translation separated by " / " for non-English', () => {
    assert.equal(rulesLinkText('es'), 'Rules / Reglas');
    assert.equal(rulesLinkText('pt'), 'Rules / Regras');
    assert.equal(rulesLinkText('fr'), 'Rules / Règles');
    assert.equal(rulesLinkText('nl'), 'Rules / Regels');
    assert.equal(rulesLinkText('ht'), 'Rules / Règ');
  });
});

describe('submissionTrackerLinkText', () => {
  test('returns plain "Submission Tracker" for English / undefined / unknown', () => {
    assert.equal(submissionTrackerLinkText(undefined), 'Submission Tracker');
    assert.equal(submissionTrackerLinkText(''), 'Submission Tracker');
    assert.equal(submissionTrackerLinkText('en'), 'Submission Tracker');
    assert.equal(submissionTrackerLinkText('xx'), 'Submission Tracker');
  });

  test('appends translation separated by " / " for non-English', () => {
    assert.equal(
      submissionTrackerLinkText('es'),
      'Submission Tracker / Rastreador de Envíos',
    );
    assert.equal(
      submissionTrackerLinkText('pt'),
      'Submission Tracker / Rastreador de Envios',
    );
    assert.equal(
      submissionTrackerLinkText('fr'),
      'Submission Tracker / Suivi des Soumissions',
    );
    assert.equal(
      submissionTrackerLinkText('nl'),
      'Submission Tracker / Inzendingen-tracker',
    );
    assert.equal(
      submissionTrackerLinkText('ht'),
      'Submission Tracker / Swivi Soumisyon',
    );
  });
});

describe('leaderboardLinkText', () => {
  test('returns plain "Leaderboard" for English / undefined / unknown', () => {
    assert.equal(leaderboardLinkText(undefined), 'Leaderboard');
    assert.equal(leaderboardLinkText(''), 'Leaderboard');
    assert.equal(leaderboardLinkText('en'), 'Leaderboard');
    assert.equal(leaderboardLinkText('xx'), 'Leaderboard');
  });

  test('appends translation separated by " / " for non-English', () => {
    assert.equal(leaderboardLinkText('es'), 'Leaderboard / Clasificación');
    assert.equal(leaderboardLinkText('pt'), 'Leaderboard / Classificação');
    assert.equal(leaderboardLinkText('fr'), 'Leaderboard / Classement');
    assert.equal(leaderboardLinkText('nl'), 'Leaderboard / Klassement');
    assert.equal(leaderboardLinkText('ht'), 'Leaderboard / Klasman');
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
