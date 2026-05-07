import { parseArgs } from 'node:util';
import { isMain, parseRound } from './cli-helpers.ts';
import {
  eligibleForNextRound,
  eliminationsForRound,
  formatStandings,
  type RoundFile,
  submitters,
} from './round-domain.ts';
import {
  DEFAULT_ROUNDS_DIR,
  readRound,
  resolveRound,
  roundPath,
  writeRoundAtomic,
} from './round-file.ts';

const USAGE = `Usage: yarn end-round [--round N] [--rounds-dir <dir>]

Closes the active round (or --round N if explicit). Computes eliminations, prints
the standings + winner/stalemate banner, and stamps the round's ended_at marker.
Re-running on an already-ended round prints the same output without mutating the
round file.

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
  -h, --help            Show this message
`;

export interface EndRoundDeps {
  roundsDir: string;
  explicitRound?: number;
  now?: () => Date;
}

export interface EndRoundResult {
  round: number;
  path: string;
  output: string;
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
  endedAt: string;
  wasAlreadyEnded: boolean;
  file: RoundFile;
}

export async function endRound(deps: EndRoundDeps): Promise<EndRoundResult> {
  const { entry, file: current } = await resolveRound({
    roundsDir: deps.roundsDir,
    explicitRound: deps.explicitRound,
    missingMessage: 'no active round to end',
  });
  const path = entry.path;

  // Load previous round for DNS computation when N >= 2.
  let prev: RoundFile | null = null;
  if (current.properties.round >= 2) {
    const prevPath = roundPath(current.properties.round - 1, deps.roundsDir);
    prev = await readRound(prevPath);
  }

  const eliminations = eliminationsForRound(current);
  const submittersCurrent = new Set(submitters(current));

  let dnsSet: ReadonlySet<string>;
  if (prev) {
    const eligPrev = eligibleForNextRound(prev);
    dnsSet = new Set([...eligPrev].filter((p) => !submittersCurrent.has(p)));
  } else {
    dnsSet = new Set();
  }

  const nextEligible = eligibleForNextRound(current);

  const output = formatRoundOutput({
    round: current.properties.round,
    standings: formatStandings(current),
    eliminations,
    dnsSet,
    nextEligible,
  });

  if (current.properties.ended_at === null) {
    const now = deps.now ?? (() => new Date());
    const endedAt = now().toISOString();
    const updated: RoundFile = {
      ...current,
      properties: { ...current.properties, ended_at: endedAt },
    };
    await writeRoundAtomic(path, updated);
    return {
      round: current.properties.round,
      path,
      output,
      eliminations,
      dnsSet,
      nextEligible,
      endedAt,
      wasAlreadyEnded: false,
      file: updated,
    };
  }

  return {
    round: current.properties.round,
    path,
    output,
    eliminations,
    dnsSet,
    nextEligible,
    endedAt: current.properties.ended_at,
    wasAlreadyEnded: true,
    file: current,
  };
}

interface FormatInput {
  round: number;
  standings: string;
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
}

function formatRoundOutput(input: FormatInput): string {
  const sections: string[] = [];
  sections.push(`Round ${input.round} results`);
  sections.push('');
  sections.push(input.standings);

  if (input.eliminations.size > 0 || input.dnsSet.size > 0) {
    sections.push('');
    sections.push('Eliminated:');
    if (input.eliminations.size === 1) {
      const [only] = input.eliminations;
      sections.push(`  ${only} (last place)`);
    } else if (input.eliminations.size > 1) {
      const sorted = [...input.eliminations].sort();
      sections.push(`  ${sorted.join(', ')} (tied for last, within 25 m)`);
    }
    if (input.dnsSet.size > 0) {
      const sorted = [...input.dnsSet].sort();
      for (const name of sorted) {
        sections.push(`  ${name} (did not submit)`);
      }
    }
  }

  sections.push('');
  if (input.nextEligible.size === 0) {
    sections.push('Game over: stalemate (no winner).');
  } else if (input.nextEligible.size === 1) {
    const [winner] = input.nextEligible;
    sections.push(`Game over. Winner: ${winner}`);
  } else {
    const sorted = [...input.nextEligible].sort();
    sections.push(`Round ${input.round + 1} starts with: ${sorted.join(', ')}`);
  }

  return sections.join('\n');
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      round: { type: 'string' },
      'rounds-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const explicitRound = parseRound(values.round, fail);
  const roundsDir = values['rounds-dir'] ?? DEFAULT_ROUNDS_DIR;

  const result = await endRound({ roundsDir, explicitRound });
  process.stdout.write(`${result.output}\n`);
}

if (isMain(import.meta.url)) {
  await main();
}
