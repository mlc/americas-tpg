import { parseArgs } from 'node:util';
import { isMain, parseRng } from './cli-helpers.ts';
import { type GadmHandle, openGadm } from './gadm.ts';
import { createRng, type RandomSource } from './rng.ts';
import {
  formatLocation,
  formatTargetLine,
  type RoundFile,
  type TargetFeature,
} from './round-domain.ts';
import {
  DEFAULT_ROUNDS_DIR,
  findLatestRound,
  roundPath,
  writeRoundAtomic,
} from './round-file.ts';
import { samplePosition } from './sampler.ts';

const USAGE = `Usage: yarn create-round [--rng <crypto|math|random.org>] [--rounds-dir <dir>]

Creates a new round file in the rounds/ directory containing a randomly sampled
Americas target, and prints the target's human-readable single-line description.

Options:
      --rng <name>      Random source: crypto (default), math, or random.org
      --rounds-dir <d>  Rounds directory (default: rounds)
  -h, --help            Show this message
`;

export interface CreateRoundDeps {
  generateTarget: () => Promise<TargetFeature>;
  roundsDir: string;
}

export interface CreateRoundResult {
  path: string;
  round: number;
  targetLine: string;
  file: RoundFile;
}

export async function createRound(
  deps: CreateRoundDeps,
): Promise<CreateRoundResult> {
  const { generateTarget, roundsDir } = deps;

  const latest = await findLatestRound(roundsDir);
  if (latest && latest.file.properties.ended_at === null) {
    throw new Error(
      `cannot create new round: round ${latest.entry.round} (${latest.entry.path}) is still active. End it first with \`yarn end-round\`.`,
    );
  }
  const nextRound = latest ? latest.entry.round + 1 : 1;
  const path = roundPath(nextRound, roundsDir);

  const target = await generateTarget();

  const file: RoundFile = {
    type: 'FeatureCollection',
    properties: { round: nextRound, ended_at: null },
    features: [target],
  };
  await writeRoundAtomic(path, file);

  return {
    path,
    round: nextRound,
    targetLine: formatTargetLine(target),
    file,
  };
}

const MAX_SAMPLE_ATTEMPTS = 10_000;

export async function sampleTargetFromGadm(
  rng: RandomSource,
  gadm: GadmHandle,
): Promise<TargetFeature> {
  for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
    const position = await samplePosition(rng);
    const lookup = gadm.lookup(position);
    if (lookup.kind !== 'accept') continue;
    const location = formatLocation({
      name_0: lookup.feature.properties.name_0,
      name_1: lookup.feature.properties.name_1,
    });
    if (location === null) continue;
    return {
      type: 'Feature',
      id: 'target',
      geometry: { type: 'Point', coordinates: position },
      properties: { location },
    };
  }
  throw new Error(
    `failed to sample a valid Americas target after ${MAX_SAMPLE_ATTEMPTS} attempts; check that GADM_PATH points to the correct geopackage`,
  );
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rng: { type: 'string' },
      'rounds-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const rngName = parseRng(values.rng, fail);
  const roundsDir = values['rounds-dir'] ?? DEFAULT_ROUNDS_DIR;

  const rng = createRng(rngName);
  const gadm = await openGadm();
  try {
    const result = await createRound({
      generateTarget: () => sampleTargetFromGadm(rng, gadm),
      roundsDir,
    });
    process.stdout.write(`${result.targetLine}\n`);
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
