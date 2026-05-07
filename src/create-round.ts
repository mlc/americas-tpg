import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type GadmHandle, openGadm } from './gadm.ts';
import {
  createRng,
  type RandomSource,
  type RngName,
  rngFactories,
} from './rng.ts';
import {
  formatLocation,
  formatTargetLine,
  type RoundFile,
  type TargetFeature,
} from './round-domain.ts';
import {
  DEFAULT_ROUNDS_DIR,
  findActiveRound,
  listRoundFiles,
  roundPath,
  writeRoundAtomic,
} from './round-file.ts';
import { samplePosition } from './sampler.ts';

const RNG_NAMES = Object.keys(rngFactories) as RngName[];

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

  // R15: refuse if any prior round is unended.
  const active = await findActiveRound(roundsDir);
  if (active) {
    throw new Error(
      `cannot create new round: round ${active.entry.round} (${active.entry.path}) is still active. End it first with \`yarn end-round\`.`,
    );
  }

  // Determine next round number from the highest existing index + 1.
  const existing = await listRoundFiles(roundsDir);
  const nextRound =
    existing.length === 0 ? 1 : existing[existing.length - 1].round + 1;
  const path = roundPath(nextRound, roundsDir);

  // R4 / AE8: refuse to overwrite an existing file at the resolved path.
  // Defensive — listRoundFiles + nextRound already prevents normal collisions.
  try {
    await access(path, fsConstants.F_OK);
    throw new Error(
      `round file already exists at ${path}; refusing to overwrite`,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }

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

export async function sampleTargetFromGadm(
  rng: RandomSource,
  gadm: GadmHandle,
): Promise<TargetFeature> {
  while (true) {
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
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseRng(raw: string | undefined): RngName {
  if (raw === undefined) return 'crypto';
  if ((RNG_NAMES as string[]).includes(raw)) return raw as RngName;
  fail(
    `Invalid --rng value: '${raw}'. Expected one of: ${RNG_NAMES.join(', ')}.`,
  );
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

  const rngName = parseRng(values.rng);
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

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
