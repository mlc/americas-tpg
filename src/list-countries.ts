import { parseArgs } from 'node:util';
import { isMain } from './cli-helpers.ts';
import { openGadm, REJECTED_GIDS } from './gadm.ts';
import { SAMPLING_BBOX } from './sampler.ts';

const USAGE = `Usage: yarn list-countries

Prints every country (GID_0  NAME_0) whose GADM bounding box intersects the
sampler's Americas-shaped band, excluding mainland USA and South Georgia/SSI.
The list is potentially over-inclusive at the margins: bbox intersection is a
necessary but not sufficient condition for a sampled point to actually land in
the country.

Options:
  -h, --help  Show this message
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const gadm = await openGadm();
  try {
    const countries = gadm
      .candidateCountries(SAMPLING_BBOX)
      .filter((c) => !REJECTED_GIDS.has(c.gid_0));
    for (const { gid_0, name_0 } of countries) {
      process.stdout.write(`${gid_0}  ${name_0}\n`);
    }
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
