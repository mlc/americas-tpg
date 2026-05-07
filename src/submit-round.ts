import { parseArgs } from 'node:util';
import { distance } from '@turf/distance';
import type { Position } from 'geojson';
import { isMain, parseRound } from './cli-helpers.ts';
import { type GadmHandle, openGadm } from './gadm.ts';
import {
  formatLocation,
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

const USAGE = `Usage: yarn submit-round <player> <lat> <lng> [--round N] [--rounds-dir <dir>]

Records a player submission against the active round (or --round N if explicit).

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
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
  const player = deps.player.trim();
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

  // Load previous round when needed for eligibility (round N >= 2).
  let prevRound: RoundFile | null = null;
  if (currentRound.properties.round >= 2) {
    const prevPath = roundPath(
      currentRound.properties.round - 1,
      deps.roundsDir,
    );
    prevRound = await readRound(prevPath);
  }

  const eligibility = validateSubmissionEligibility({
    player,
    currentRound,
    prevRound,
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
    round: currentRound.properties.round,
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

const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function parseCoord(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (!NUMERIC_RE.test(trimmed)) {
    return fail(`Invalid ${label}: '${raw}'. Expected a decimal number.`);
  }
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) {
    return fail(`Invalid ${label}: '${raw}'. Expected a finite number.`);
  }
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      round: { type: 'string' },
      'rounds-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (positionals.length !== 3) {
    fail(
      `Expected 3 positional arguments (<player> <lat> <lng>), got ${positionals.length}.`,
    );
  }

  const [player, latRaw, lngRaw] = positionals;
  const lat = parseCoord(latRaw, 'lat');
  const lng = parseCoord(lngRaw, 'lng');
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
  await main();
}
