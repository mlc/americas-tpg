import { parseArgs } from 'node:util';
import type { Position } from 'geojson';
import { isMain, parseRound } from './cli-helpers.ts';
import { formatCoords } from './format.ts';
import {
  type LookupLocation,
  makeGadmLookupLocation,
  openGadm,
} from './gadm.ts';
import {
  isMorphiorDbError,
  type MorphiorClient,
  openMorphiorClient,
} from './morphiordb.ts';
import {
  applyDnsSaveRule,
  type DnsCheck,
  eliminationsForRound,
  eliminationsFromFlags,
  endedAtOf,
  evaluateDnsCheck,
  formatRoundResultDiscord,
  formatStandings,
  type RoundFile,
  submissionsOf,
  submitters,
  targetOf,
} from './round-domain.ts';
import {
  DEFAULT_ROUNDS_DIR,
  listSubmissionsForPlayer,
  readRound,
  resolveRound,
  roundPath,
  writeRoundAtomic,
} from './round-file.ts';

const USAGE = `Usage: yarn end-round [--round N] [--rounds-dir <dir>]

Closes the active round (or --round N if explicit). Computes eliminations, prints
the standings + winner/stalemate banner, and stamps the round's endedAt marker.
Re-running on an already-ended round prints the same output without mutating the
round file.

First-run also evaluates the honest-DNS save rule: for each player who failed
to submit, gathers their submission history (this game's prior rounds plus a
best-effort query against the MorphiorDB API) and decides whether they could
have escaped elimination. If not, the actual last-place submitter(s) are
spared. MorphiorDB unavailability degrades to local-only history without
blocking round-close. Output may include "Saved by honest-DNS rule" and
"DNS could-have-sent" sections.

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
  -h, --help            Show this message
`;

export interface EndRoundDeps {
  roundsDir: string;
  explicitRound?: number;
  now?: () => Date;
  /** Optional MorphiorDB client. Defaults to a freshly-opened client against
   * the production endpoint. Tests inject a stub via this seam. */
  morphiorClient?: MorphiorClient;
  /** Optional location lookup for rendering DNS could-have-sent example
   * coords. Defaults to a GADM-backed lookup; the CLI opens GADM and closes
   * it in a `finally`. Tests inject a stub via this seam to avoid GADM I/O. */
  lookupLocation?: LookupLocation;
}

export interface EndRoundResult {
  round: number;
  path: string;
  output: string;
  /** Players eliminated this round in the post-honest-DNS-rule sense.
   * On first-run, this is `eliminationsForRound(current)` minus `savedSet`.
   * On re-end, it's read from the persisted `eliminated === true` flags
   * (which were stamped post-rule on the first run). Callers wanting the
   * pre-rule distance-derived set should compute `eliminationsForRound`
   * themselves; the players spared by the rule are in `savedSet`. */
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
  /** Submitters spared by the honest-DNS save rule (subset of the
   * distance-derived eliminations). Empty when the rule didn't fire. */
  savedSet: ReadonlySet<string>;
  /** Per-DNS-player rule evaluations. Persisted at `roundInfo.dnsChecks`
   * for re-end determinism. */
  dnsChecks: readonly DnsCheck[];
  endedAt: string;
  wasAlreadyEnded: boolean;
  file: RoundFile;
  /** Discord-pasteable summary of the round's outcome. Three-line shape:
   * `## Round N complete` header, one line per eliminated submitter/DNS,
   * trailing `M players remain.` / winner / stalemate footer. */
  discordMessage: string;
}

export async function endRound(deps: EndRoundDeps): Promise<EndRoundResult> {
  const { entry, file: current } = await resolveRound({
    roundsDir: deps.roundsDir,
    explicitRound: deps.explicitRound,
    missingMessage: 'no active round to end',
  });
  const path = entry.path;
  const round = entry.round;

  // Load previous round for DNS computation when N >= 2.
  let prev: RoundFile | null = null;
  if (round >= 2) {
    const prevPath = roundPath(round - 1, deps.roundsDir);
    prev = await readRound(prevPath);
  }

  const submittersCurrent = new Set(submitters(current));
  let dnsSet: ReadonlySet<string>;
  if (prev) {
    if (endedAtOf(prev) === null) {
      throw new Error(
        `endRound: previous round ${round - 1} must be ended before round ${round} can be closed`,
      );
    }
    // Prev is ended → its submissions carry persisted `eliminated` flags.
    // DNS = previous round's survivors minus current round's submitters.
    const survivorsPrev = submissionsOf(prev)
      .filter((s) => s.properties.eliminated === false)
      .map((s) => s.properties.player);
    dnsSet = new Set(survivorsPrev.filter((p) => !submittersCurrent.has(p)));
  } else {
    dnsSet = new Set();
  }

  // Default to a null-lookup stub if not provided. The CLI opens GADM
  // explicitly and passes a real lookup; tests inject their own stubs.
  const lookupLocation = deps.lookupLocation ?? ((): null => null);
  const existingEndedAt = endedAtOf(current);

  if (existingEndedAt === null) {
    // First-run: evaluate the honest-DNS save rule, stamp flags, persist.
    const distanceEliminations = eliminationsForRound(current);
    const target = targetOf(current).geometry.coordinates;
    const subs = submissionsOf(current);
    const currentMaxKm =
      subs.length === 0
        ? 0
        : Math.max(...subs.map((s) => s.properties.distance));

    const morphior = deps.morphiorClient ?? openMorphiorClient();
    const dnsChecks: DnsCheck[] = [];
    for (const player of [...dnsSet].sort()) {
      const dnsCheck = await evaluateDnsForPlayer({
        player,
        target,
        currentMaxKm,
        round,
        roundsDir: deps.roundsDir,
        morphior,
      });
      dnsChecks.push(dnsCheck);
    }

    const savedSet = applyDnsSaveRule(distanceEliminations, dnsChecks);
    const finalEliminations = new Set(
      [...distanceEliminations].filter((p) => !savedSet.has(p)),
    );

    const updatedSubmissions = subs.map((sub) => ({
      ...sub,
      properties: {
        ...sub.properties,
        eliminated: finalEliminations.has(sub.properties.player),
      },
    }));

    const now = deps.now ?? (() => new Date());
    const endedAt = now().toISOString();
    const updated: RoundFile = {
      ...current,
      roundInfo: { ...current.roundInfo, endedAt, dnsChecks },
      features: [targetOf(current), ...updatedSubmissions],
    };
    await writeRoundAtomic(path, updated);

    const nextEligible = new Set(
      submitters(current).filter((p) => !finalEliminations.has(p)),
    );
    const output = formatRoundOutput({
      round,
      standings: formatStandings(current),
      eliminations: finalEliminations,
      dnsSet,
      nextEligible,
      savedSet,
      dnsChecks,
      lookupLocation,
    });
    const discordMessage = formatRoundResultDiscord({
      round: updated,
      eliminations: finalEliminations,
      dnsSet,
      nextEligible,
      savedSet,
      dnsChecks,
    });
    return {
      round,
      path,
      output,
      eliminations: finalEliminations,
      dnsSet,
      nextEligible,
      savedSet,
      dnsChecks,
      endedAt,
      wasAlreadyEnded: false,
      file: updated,
      discordMessage,
    };
  }

  // Re-end: read persisted state. No MorphiorDB call, no file write.
  const persistedEliminations = eliminationsFromFlags(current);
  const distanceEliminations = eliminationsForRound(current);
  const savedSet = new Set(
    [...distanceEliminations].filter((p) => !persistedEliminations.has(p)),
  );
  // Validator invariant: ended rounds must carry dnsChecks (round-file.ts
  // enforces presence-iff-ended). The fallback is unreachable in normal
  // flow; throw loudly if the invariant ever weakens so we don't silently
  // synthesize an empty saved-set.
  if (!current.roundInfo.dnsChecks) {
    throw new Error(
      `endRound (re-end): ended round ${round} is missing roundInfo.dnsChecks — validator invariant violated`,
    );
  }
  const dnsChecks = current.roundInfo.dnsChecks;
  const nextEligible = new Set(
    submitters(current).filter((p) => !persistedEliminations.has(p)),
  );
  const output = formatRoundOutput({
    round,
    standings: formatStandings(current),
    eliminations: persistedEliminations,
    dnsSet,
    nextEligible,
    savedSet,
    dnsChecks,
    lookupLocation,
  });
  const discordMessage = formatRoundResultDiscord({
    round: current,
    eliminations: persistedEliminations,
    dnsSet,
    nextEligible,
    savedSet,
    dnsChecks,
  });
  return {
    round,
    path,
    output,
    eliminations: persistedEliminations,
    dnsSet,
    nextEligible,
    savedSet,
    dnsChecks,
    endedAt: existingEndedAt,
    wasAlreadyEnded: true,
    file: current,
    discordMessage,
  };
}

interface DnsEvaluationContext {
  player: string;
  target: Position;
  currentMaxKm: number;
  round: number;
  roundsDir: string;
  morphior: MorphiorClient;
}

async function evaluateDnsForPlayer(
  ctx: DnsEvaluationContext,
): Promise<DnsCheck> {
  const localPoints = await listSubmissionsForPlayer(
    ctx.player,
    ctx.roundsDir,
    {
      excludeRound: ctx.round,
    },
  );

  let morphiorDbStatus: DnsCheck['morphiorDbStatus'] = 'unavailable';
  let morphiorDbSubmissionCount: number | null = null;
  let mdbPoints: readonly Position[] = [];
  try {
    const matches = await ctx.morphior.findPlayers(ctx.player);
    if (matches.length === 1) {
      const [match] = matches;
      mdbPoints = await ctx.morphior.fetchSubmissions(match.discord_id);
      morphiorDbStatus = 'ok';
      morphiorDbSubmissionCount = mdbPoints.length;
    } else {
      // Zero exact matches OR ambiguous (multiple exact). Either way the
      // rule falls back to local-only history; the audit trail records the
      // outcome via `noMatch`.
      morphiorDbStatus = 'noMatch';
    }
  } catch (err) {
    if (!isMorphiorDbError(err)) throw err;
    morphiorDbStatus = 'unavailable';
    process.stderr.write(
      `endRound: MorphiorDB unavailable for ${ctx.player}: ${err.message}\n`,
    );
  }

  const allPoints = [...localPoints, ...mdbPoints];
  const evaluation = evaluateDnsCheck(ctx.target, allPoints, ctx.currentMaxKm);
  return {
    player: ctx.player,
    best: evaluation.best,
    couldHaveEscaped: evaluation.couldHaveEscaped,
    morphiorDbStatus,
    morphiorDbSubmissionCount,
  };
}

interface FormatInput {
  round: number;
  standings: string;
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
  savedSet: ReadonlySet<string>;
  dnsChecks: readonly DnsCheck[];
  lookupLocation: LookupLocation;
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

  if (input.savedSet.size > 0) {
    const honest = input.dnsChecks
      .filter((c) => !c.couldHaveEscaped)
      .sort((a, b) => a.player.localeCompare(b.player));
    sections.push('');
    sections.push('Saved by honest-DNS rule:');
    const saved = [...input.savedSet].sort();
    const triggerList =
      honest.length > 0
        ? ` (triggered by ${honest
            .map(
              (c) =>
                `${c.player}'s best historical at ${formatBestDistance(c)}`,
            )
            .join('; ')})`
        : '';
    for (const name of saved) {
      sections.push(`  ${name}${triggerList}`);
    }
  }

  if (input.dnsChecks.length > 0) {
    sections.push('');
    sections.push('DNS could-have-sent:');
    for (const check of input.dnsChecks.toSorted((a, b) =>
      a.player.localeCompare(b.player),
    )) {
      sections.push(
        `  ${check.player}: ${formatDnsCheckDetail(check, input.lookupLocation)}`,
      );
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

function formatBestDistance(check: DnsCheck): string {
  if (check.best === null) return 'no submission history available';
  return `${check.best.distanceKm.toFixed(3)} km`;
}

function formatDnsCheckDetail(
  check: DnsCheck,
  lookupLocation: LookupLocation,
): string {
  if (check.best === null) return 'no submission history available';
  const coords = formatCoords(check.best.point);
  const region = lookupLocation(check.best.point);
  const where = region ? `${coords}, ${region}` : coords;
  return `${check.best.distanceKm.toFixed(3)} km from target (${where})`;
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

  const gadm = await openGadm();
  try {
    const result = await endRound({
      roundsDir,
      explicitRound,
      lookupLocation: makeGadmLookupLocation(gadm),
    });
    process.stdout.write(`${result.output}\n\n${result.discordMessage}\n`);
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
