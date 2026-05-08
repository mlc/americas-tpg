import { parseArgs } from 'node:util';
import { distance } from '@turf/distance';
import type { Position } from 'geojson';
import { isMain, parseRound } from './cli-helpers.ts';
import { decodeCoord } from './coords.ts';
import { type GadmHandle, openGadm } from './gadm.ts';
import {
  formatLocation,
  normalizePlayerName,
  type RoundFeature,
  type RoundFile,
  type SubmissionFeature,
  submissionsOf,
  validateSubmissionEligibility,
} from './round-domain.ts';
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
separate positionals (40.7128 -74.0060). Decimal, NESW, and DMS forms are all
accepted (e.g. "40.7128°N 74.0060°W", "40:42:46N 74:00:21W").

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
      --force           Accept the submission even if the player is ineligible
                        from the previous round (round-ended check still applies)
  -h, --help            Show this message
`;

export type LookupLocation = (position: Position) => string | null;
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

export function makeGadmLookupLocation(gadm: GadmHandle): LookupLocation {
  return (position) => {
    const result = gadm.lookup(position);
    if (result.kind === 'ocean') return null;
    return formatLocation({
      name_0: result.feature.properties.name_0,
      name_1: result.feature.properties.name_1,
    });
  };
}

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
  const { values, positionals } = parseArgs({
    options: {
      round: { type: 'string' },
      'rounds-dir': { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
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
