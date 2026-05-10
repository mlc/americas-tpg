export const GID0_TO_ISO639_1: Record<string, string> = {
  // English
  AIA: 'en',
  ATG: 'en',
  BHS: 'en',
  BRB: 'en',
  BLZ: 'en',
  BMU: 'en',
  VGB: 'en',
  CYM: 'en',
  DMA: 'en',
  FLK: 'en',
  GRD: 'en',
  GUY: 'en',
  JAM: 'en',
  MSR: 'en',
  KNA: 'en',
  LCA: 'en',
  VCT: 'en',
  TTO: 'en',
  TCA: 'en',
  UMI: 'en',
  VIR: 'en',
  // Spanish
  ARG: 'es',
  BOL: 'es',
  CHL: 'es',
  COL: 'es',
  CRI: 'es',
  CUB: 'es',
  DOM: 'es',
  ECU: 'es',
  SLV: 'es',
  GTM: 'es',
  HND: 'es',
  MEX: 'es',
  NIC: 'es',
  PAN: 'es',
  PRY: 'es',
  PER: 'es',
  PRI: 'es',
  URY: 'es',
  VEN: 'es',
  // Portuguese
  BRA: 'pt',
  // French
  XCL: 'fr',
  GUF: 'fr',
  GLP: 'fr',
  MTQ: 'fr',
  BLM: 'fr',
  MAF: 'fr',
  // Haitian Creole
  HTI: 'ht',
  // Dutch
  ABW: 'nl',
  BES: 'nl',
  CUW: 'nl',
  SXM: 'nl',
  SUR: 'nl',
};

export function mainLanguageOf(gid_0: string | undefined): string | undefined {
  if (!gid_0) return undefined;
  return GID0_TO_ISO639_1[gid_0];
}

// Country names rendered in the country's main language (per GID0_TO_ISO639_1).
// Names match the GADM English spelling unless the country's main language
// differs, in which case we use the local form.
export const GID0_TO_LOCAL_NAME: Record<string, string> = {
  // English
  AIA: 'Anguilla',
  ATG: 'Antigua and Barbuda',
  BHS: 'Bahamas',
  BRB: 'Barbados',
  BLZ: 'Belize',
  BMU: 'Bermuda',
  VGB: 'British Virgin Islands',
  CYM: 'Cayman Islands',
  DMA: 'Dominica',
  FLK: 'Falkland Islands',
  GRD: 'Grenada',
  GUY: 'Guyana',
  JAM: 'Jamaica',
  MSR: 'Montserrat',
  KNA: 'Saint Kitts and Nevis',
  LCA: 'Saint Lucia',
  VCT: 'Saint Vincent and the Grenadines',
  TTO: 'Trinidad and Tobago',
  TCA: 'Turks and Caicos Islands',
  UMI: 'United States Minor Outlying Islands',
  VIR: 'United States Virgin Islands',
  // Spanish
  ARG: 'Argentina',
  BOL: 'Bolivia',
  CHL: 'Chile',
  COL: 'Colombia',
  CRI: 'Costa Rica',
  CUB: 'Cuba',
  DOM: 'República Dominicana',
  ECU: 'Ecuador',
  SLV: 'El Salvador',
  GTM: 'Guatemala',
  HND: 'Honduras',
  MEX: 'México',
  NIC: 'Nicaragua',
  PAN: 'Panamá',
  PRY: 'Paraguay',
  PER: 'Perú',
  PRI: 'Puerto Rico',
  URY: 'Uruguay',
  VEN: 'Venezuela',
  // Portuguese
  BRA: 'Brasil',
  // French
  XCL: 'Île de Clipperton',
  GUF: 'Guyane',
  GLP: 'Guadeloupe',
  MTQ: 'Martinique',
  BLM: 'Saint-Barthélemy',
  MAF: 'Saint-Martin',
  // Haitian Creole
  HTI: 'Ayiti',
  // Dutch
  ABW: 'Aruba',
  BES: 'Caribisch Nederland',
  CUW: 'Curaçao',
  SXM: 'Sint Maarten',
  SUR: 'Suriname',
};

export function mainCountryName(gid_0: string | undefined): string | undefined {
  if (!gid_0) return undefined;
  return GID0_TO_LOCAL_NAME[gid_0];
}

export const ROUND_LABEL: Record<string, string> = {
  en: 'Round',
  es: 'Ronda',
  pt: 'Rodada',
  fr: 'Manche',
  nl: 'Ronde',
  ht: 'Tou',
};

export function roundLabel(language: string | undefined): string {
  if (!language) return 'Round';
  return ROUND_LABEL[language] ?? 'Round';
}

export const RULES_LABEL: Record<string, string> = {
  en: 'Rules',
  es: 'Reglas',
  pt: 'Regras',
  fr: 'Règles',
  nl: 'Regels',
  ht: 'Règ',
};

/**
 * Link text for the rules link in the round announcement: `Rules` in English,
 * or `Rules / <translation>` when the round's language is non-English. Falls
 * back to plain `Rules` for unknown / missing language.
 */
export function rulesLinkText(language: string | undefined): string {
  if (!language || language === 'en') return 'Rules';
  const translated = RULES_LABEL[language];
  return translated ? `Rules / ${translated}` : 'Rules';
}

export const SUBMISSION_TRACKER_LABEL: Record<string, string> = {
  en: 'Submission Tracker',
  es: 'Rastreador de Envíos',
  pt: 'Rastreador de Envios',
  fr: 'Suivi des Soumissions',
  nl: 'Inzendingen-tracker',
  ht: 'Swivi Soumisyon',
};

/**
 * Link text for the submission-tracker link in the round announcement:
 * `Submission Tracker` in English, or `Submission Tracker / <translation>`
 * when the round's language is non-English. Same fallback rules as
 * `rulesLinkText`.
 */
export function submissionTrackerLinkText(
  language: string | undefined,
): string {
  if (!language || language === 'en') return 'Submission Tracker';
  const translated = SUBMISSION_TRACKER_LABEL[language];
  return translated
    ? `Submission Tracker / ${translated}`
    : 'Submission Tracker';
}
