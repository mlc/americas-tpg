import { parseArgs } from 'node:util';
import { isMain, parseRound } from './cli-helpers.ts';
import {
  eliminationsForRound,
  endedAtOf,
  roundExpiry,
  submissionsOf,
  submissionTrackerUrl,
  submitters,
} from './round-domain.ts';
import {
  DEFAULT_ROUNDS_DIR,
  readRound,
  resolveRound,
  roundPath,
} from './round-file.ts';

const USAGE = `Usage: yarn send-reminders [--round N] [--rounds-dir <dir>]

Lists players eligible to submit to the active round who have not yet done so,
formatted as a Discord-pasteable message with @-mentions and a submission-tracker
link. Errors on round 1 (no prior round to derive eligibility from) and on rounds
that are already ended.

Options:
      --round N         Target a specific round (default: latest unended round)
      --rounds-dir <d>  Rounds directory (default: rounds)
  -h, --help            Show this message
`;

export interface SendRemindersDeps {
  roundsDir: string;
  explicitRound?: number;
}

export interface SendRemindersResult {
  round: number;
  pending: readonly string[];
  message: string;
}

export async function sendReminders(
  deps: SendRemindersDeps,
): Promise<SendRemindersResult> {
  const { entry, file: current } = await resolveRound({
    roundsDir: deps.roundsDir,
    explicitRound: deps.explicitRound,
    missingMessage: 'no active round; run `yarn create-round` first',
  });
  const round = entry.round;
  if (endedAtOf(current) !== null) {
    throw new Error(`round ${round} is ended; submissions are closed`);
  }
  if (round === 1) {
    throw new Error(
      'cannot send reminders for round 1: no prior round to derive eligibility from',
    );
  }

  // Mirror `validateSubmissionEligibility`'s precondition: prev round must be
  // ended so the `eliminated` flag we read is the post-save-rule answer, not
  // an in-progress no-op.
  const prev = await readRound(roundPath(round - 1, deps.roundsDir));
  if (endedAtOf(prev) === null) {
    throw new Error(
      `cannot send reminders: round ${round - 1} (the prior round) is not ended`,
    );
  }

  const eligible = new Set(
    submissionsOf(prev)
      .filter((s) => s.properties.eliminated === false)
      .map((s) => s.properties.player),
  );
  const submitted = new Set(submitters(current));
  const pending = [...eligible].filter((p) => !submitted.has(p)).sort();

  const trackerLink = `[Submission Tracker](${submissionTrackerUrl(round)})`;
  const received = eligible.size - pending.length;
  const expiry = roundExpiry(undefined, 0);
  const eliminationNames = [...eliminationsForRound(current)].sort();
  const headerClauses = [
    `Round ${round}`,
    `${received}/${eligible.size} submissions received`,
    ...(eliminationNames.length > 0
      ? [`${eliminationNames.join(', ')} in elimination position`]
      : []),
    `round ends at <t:${expiry.epochSecond()}:t>`,
  ];
  const lines: string[] = [headerClauses.join(', ')];
  if (pending.length > 0) {
    lines.push(pending.map((p) => `@${p}`).join(' '));
  }
  lines.push(trackerLink);
  const message = lines.join('\n');

  return { round, pending, message };
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

  const result = await sendReminders({ roundsDir, explicitRound });
  process.stdout.write(`${result.message}\n`);
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}
