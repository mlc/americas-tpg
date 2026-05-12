import { parseArgs } from 'node:util';
import { distance } from '@turf/distance';
import type { Position } from 'geojson';
import { isMain, parseRound } from './cli-helpers.ts';
import { decodeCoord } from './coords.ts';
import {
  type LookupLocation,
  makeGadmLookupLocation,
  openGadm,
} from './gadm.ts';
import {
  normalizePlayerName,
  type RoundFeature,
  type RoundFile,
  type SubmissionFeature,
  submissionsOf,
  validateSubmissionEligibility,
} from './round-domain.ts';

export type { LookupLocation } from './gadm.ts';
export { makeGadmLookupLocation } from './gadm.ts';

import {
  DEFAULT_ROUNDS_DIR,
  readRound,
  resolveRound,
  roundPath,
  writeRoundAtomic,
} from './round-file.ts';

const USAGE = `Usage: yarn submit-round <player> <coord>... [--round N] [--rounds-dir <dir>]

Records a player submission against the active round (or --round N if explicit).
Player names are normalized (NFC + zero-width strip + trim) but compared case-
sensitively — 'Alice' and 'alice' are different players.

The coordinate may be passed as one quoted string ("40.7128, -74.0060") or as
separate positionals (40.7128 -74.0060). Decimal (US or European-comma form),
NESW, and DMS forms are all accepted (e.g. "40.7128°N 74.0060°W",
"40:42:46N 74:00:21W", "40,7128 -74,0060"). Bare negative latitudes/longitudes
(e.g. -42.5 -73.1) work without \`--\`.

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
      --force           Accept the submission even if the player is ineligible
                        from the previous round (round-ended check still applies)
  -h, --help            Show this message
`;

export type ComputeDistanceKm = (
  target: Position,
  submission: Position,
) => number;

export interface SubmitRoundDeps {
  player: string;
  lat: number;
  lng: number;
  roundsDir: string;
  explicitRound?: number;
  force?: boolean;
  lookupLocation: LookupLocation;
  computeDistance?: ComputeDistanceKm;
}

export interface SubmitRoundResult {
  path: string;
  round: number;
  player: string;
  distance: number;
  location?: string;
  replaced: boolean;
  file: RoundFile;
}

export const defaultComputeDistance: ComputeDistanceKm = (target, submission) =>
  distance(target, submission, { units: 'kilometers' });

export async function submitRound(
  deps: SubmitRoundDeps,
): Promise<SubmitRoundResult> {
  const player = normalizePlayerName(deps.player);
  if (!player) throw new Error('player name is required');
  if (!Number.isFinite(deps.lat) || deps.lat < -90 || deps.lat > 90) {
    throw new Error(
      `invalid latitude: ${deps.lat} (expected number in [-90, 90])`,
    );
  }
  if (!Number.isFinite(deps.lng) || deps.lng < -180 || deps.lng > 180) {
    throw new Error(
      `invalid longitude: ${deps.lng} (expected number in [-180, 180])`,
    );
  }

  const computeDistance = deps.computeDistance ?? defaultComputeDistance;

  const { entry, file: currentRound } = await resolveRound({
    roundsDir: deps.roundsDir,
    explicitRound: deps.explicitRound,
    missingMessage: 'no active round; run `yarn create-round` to start one',
  });
  const targetPath = entry.path;
  const currentRoundNumber = entry.round;

  // Load previous round when needed for eligibility (round N >= 2).
  let prevRound: RoundFile | null = null;
  if (currentRoundNumber >= 2) {
    const prevPath = roundPath(currentRoundNumber - 1, deps.roundsDir);
    prevRound = await readRound(prevPath);
  }

  const eligibility = validateSubmissionEligibility({
    player,
    currentRound,
    currentRoundNumber,
    prevRound,
    force: deps.force,
  });
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason ?? 'ineligible');
  }

  const submissionPos: Position = [deps.lng, deps.lat];
  const targetPos = currentRound.features[0].geometry.coordinates;
  const distanceKm = computeDistance(targetPos, submissionPos);
  const location = deps.lookupLocation(submissionPos);

  const submission: SubmissionFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: submissionPos },
    properties: {
      player,
      distance: distanceKm,
      ...(location !== null ? { location } : {}),
    },
  };

  const subIdx = submissionsOf(currentRound).findIndex(
    (s) => s.properties.player === player,
  );
  const newFeatures: RoundFeature[] = [...currentRound.features];
  let replaced = false;
  if (subIdx === -1) {
    newFeatures.push(submission);
  } else {
    // submissionsOf slices off the target at index 0; offset by 1 for newFeatures.
    newFeatures[subIdx + 1] = submission;
    replaced = true;
  }

  const updated: RoundFile = {
    ...currentRound,
    features: newFeatures,
  };

  await writeRoundAtomic(targetPath, updated);

  return {
    path: targetPath,
    round: currentRoundNumber,
    player,
    distance: distanceKm,
    ...(location !== null ? { location } : {}),
    replaced,
    file: updated,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

// parseArgs treats anything starting with `-` as an option, so a bare
// `-42.5` for a southern-hemisphere latitude trips strict mode. Pre-split argv
// into options vs. positionals using our known option surface so negative
// numbers fall through as positionals without the user typing `--`.
// PARSE_OPTIONS is the single source of truth — partitionSubmitArgs derives
// STRING_OPTS / BOOL_OPTS from it, main() passes it straight to parseArgs.
const PARSE_OPTIONS = {
  round: { type: 'string' },
  'rounds-dir': { type: 'string' },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const STRING_OPTS = new Set(
  Object.entries(PARSE_OPTIONS)
    .filter(([, v]) => v.type === 'string')
    .map(([k]) => `--${k}`),
);
const BOOL_OPTS = new Set<string>(
  Object.entries(PARSE_OPTIONS).flatMap(([k, v]) => {
    if (v.type !== 'boolean') return [];
    const labels = [`--${k}`];
    if ('short' in v) labels.push(`-${v.short}`);
    return labels;
  }),
);

// Discriminator between negative-number positionals and unknown flags. A
// bare hyphen-prefixed token is a number iff it matches /^-\.?\d/; anything
// else starting with `-` is forwarded to parseArgs so it surfaces a clear
// "Unknown option" error.
const NEGATIVE_NUMBER_RE = /^-\.?\d/;

export function partitionSubmitArgs(argv: string[]): {
  options: string[];
  positionals: string[];
} {
  const options: string[] = [];
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (STRING_OPTS.has(a)) {
      options.push(a);
      if (i + 1 < argv.length) options.push(argv[i + 1]);
      i += 2;
      continue;
    }
    if (BOOL_OPTS.has(a)) {
      options.push(a);
      i += 1;
      continue;
    }
    if (a.startsWith('-') && !NEGATIVE_NUMBER_RE.test(a)) {
      options.push(a);
      i += 1;
      continue;
    }
    positionals.push(a);
    i += 1;
  }
  return { options, positionals };
}

export function parseCoordArgs(coordParts: string[]): Position {
  if (coordParts.length === 0) {
    throw new Error(
      'Invalid coordinate: expected at least one <coord> positional.',
    );
  }
  const coordRaw = coordParts.join(' ');
  try {
    return decodeCoord(coordRaw).coordinates;
  } catch (cause) {
    throw new Error(
      `Invalid coordinate '${coordRaw}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function main(): Promise<void> {
  const { options: optionArgs, positionals } = partitionSubmitArgs(
    process.argv.slice(2),
  );
  const { values } = parseArgs({
    args: optionArgs,
    options: PARSE_OPTIONS,
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (positionals.length < 2) {
    fail(
      `Expected at least 2 positional arguments (<player> <coord>...), got ${positionals.length}.`,
    );
  }

  const [player, ...coordParts] = positionals;
  let lat: number;
  let lng: number;
  try {
    [lng, lat] = parseCoordArgs(coordParts);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
  const explicitRound = parseRound(values.round, fail);
  const roundsDir = values['rounds-dir'] ?? DEFAULT_ROUNDS_DIR;

  const gadm = await openGadm();
  try {
    const result = await submitRound({
      player,
      lat,
      lng,
      roundsDir,
      explicitRound,
      force: values.force,
      lookupLocation: makeGadmLookupLocation(gadm),
    });
    const locationPart = result.location ? `, ${result.location}` : '';
    const verb = result.replaced ? 'updated' : 'submitted';
    process.stdout.write(
      `${verb}: ${result.player} ${result.distance.toFixed(3)} km${locationPart}\n`,
    );
  } finally {
    gadm.close();
  }
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}
