import { parseArgs } from 'node:util';
import type { Feature, Point } from 'geojson';
import { formatGeoJson, formatHuman, type OutputProps } from './format.ts';
import { openGadm } from './gadm.ts';
import { createRng, type RngName, rngFactories } from './rng.ts';
import { samplePosition } from './sampler.ts';

const RNG_NAMES = Object.keys(rngFactories) as RngName[];

const USAGE = `Usage: yarn start [--count <N>] [--geojson] [--rng <crypto|math|random.org>]

Options:
  -n, --count <N>   Number of points to generate (default 1)
      --geojson     Emit a GeoJSON FeatureCollection instead of human-readable text
      --rng <name>  Random source: crypto (default), math, or random.org
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseCount(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
    fail(`Invalid --count value: '${raw}'. Expected a positive integer.`);
  }
  return n;
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
      count: { type: 'string', short: 'n' },
      geojson: { type: 'boolean', default: false },
      rng: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const count = parseCount(values.count);
  const rngName = parseRng(values.rng);
  const asGeoJson = values.geojson === true;

  const rng = createRng(rngName);
  const gadm = await openGadm();

  const results: Feature<Point, OutputProps>[] = [];
  try {
    while (results.length < count) {
      const position = await samplePosition(rng);
      const lookup = gadm.lookup(position);
      if (lookup.kind !== 'accept') continue;
      const { gid_0, name_0, gid_1, name_1 } = lookup.feature.properties;
      results.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: {
          country: name_0,
          level1: name_1,
          gid0: gid_0,
          gid1: gid_1,
        },
      });
    }
  } finally {
    gadm.close();
  }

  process.stdout.write(
    `${asGeoJson ? formatGeoJson(results) : formatHuman(results)}\n`,
  );
}

await main();
