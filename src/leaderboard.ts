import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { FeatureCollection, Point } from 'geojson';
import { isMain } from './cli-helpers.ts';
import {
  endedAtOf,
  type RoundFile,
  submissionsOf,
  submissionTrackerUrl,
  submitters,
  targetOf,
} from './round-domain.ts';
import { DEFAULT_ROUNDS_DIR, listRoundFiles, readRound } from './round-file.ts';

const DEFAULT_LEADERBOARD_PATH = 'LEADERBOARD.md';

const USAGE = `Usage: yarn leaderboard [--rounds-dir <dir>]

Writes a markdown leaderboard table to ${DEFAULT_LEADERBOARD_PATH} (in the
current working directory) summarising every ended round. Columns are rounds
(linked to their submission tracker); rows are players. Surviving players
appear first, alphabetically. Eliminated players follow, most-recently
eliminated first, with their names in italics. Cells are integer-km
distance to the target (bold on the round of elimination), or "DNS" when a
player was eligible but did not submit. In-progress rounds are skipped.

Options:
      --rounds-dir <d>  Rounds directory (default: ${DEFAULT_ROUNDS_DIR})
  -h, --help            Show this message
`;

type CellKind =
  | { kind: 'submitted'; distanceKm: number; eliminatedHere: boolean }
  | { kind: 'dns' }
  | { kind: 'blank' };

interface PlayerRow {
  player: string;
  eliminatedAt: number | null;
  cells: Map<number, CellKind>;
}

export const targetsMap = (
  rounds: readonly RoundFile[],
): FeatureCollection<Point, { round: number; location: string }> => ({
  type: 'FeatureCollection',
  features: rounds.map((round) => {
    const target = targetOf(round);
    return {
      type: 'Feature',
      geometry: target.geometry,
      properties: {
        round: round.roundInfo.number,
        location: target.properties.location,
      },
    };
  }),
});

/** Pure markdown builder. `rounds` must already be filtered to ended rounds
 * and sorted by round number ascending. Throws on empty input. */
export function buildLeaderboardMarkdown(rounds: readonly RoundFile[]): string {
  if (rounds.length === 0) {
    throw new Error('no ended rounds to render');
  }
  for (const r of rounds) {
    if (endedAtOf(r) === null) {
      throw new Error(
        `buildLeaderboardMarkdown: round ${r.roundInfo.number} is not ended`,
      );
    }
  }

  // Eligibility per round (post-save-rule survivor set of the prior round;
  // for round 1, anyone who submitted is treated as eligible from R1).
  const roundsByNumber = new Map<number, RoundFile>();
  for (const r of rounds) roundsByNumber.set(r.roundInfo.number, r);

  const eligibility = new Map<number, Set<string>>();
  for (const r of rounds) {
    const n = r.roundInfo.number;
    if (n <= 1) {
      eligibility.set(n, new Set(submitters(r)));
      continue;
    }
    const prev = roundsByNumber.get(n - 1);
    if (!prev) {
      // Prior round missing from the ended set (e.g., gap). Fall back to
      // current-round submitters so a player who only appears here isn't
      // tagged DNS retroactively.
      eligibility.set(n, new Set(submitters(r)));
      continue;
    }
    eligibility.set(
      n,
      new Set(
        submissionsOf(prev)
          .filter((s) => s.properties.eliminated === false)
          .map((s) => s.properties.player),
      ),
    );
  }

  const players = new Map<string, PlayerRow>();
  const ensure = (player: string): PlayerRow => {
    let row = players.get(player);
    if (!row) {
      row = { player, eliminatedAt: null, cells: new Map() };
      players.set(player, row);
    }
    return row;
  };

  // Walk rounds in ascending order. For each round, record cells for every
  // submitter and DNS-mark any eligible non-submitter. Record elimination
  // round (smallest N at which the player is out: eliminated:true flag or
  // DNS-out).
  for (const r of rounds) {
    const n = r.roundInfo.number;
    const submittedPlayers = new Set<string>();
    for (const sub of submissionsOf(r)) {
      const p = sub.properties.player;
      submittedPlayers.add(p);
      const row = ensure(p);
      row.cells.set(n, {
        kind: 'submitted',
        distanceKm: sub.properties.distance,
        eliminatedHere: sub.properties.eliminated === true,
      });
      if (sub.properties.eliminated === true && row.eliminatedAt === null) {
        row.eliminatedAt = n;
      }
    }
    const eligibleHere = eligibility.get(n) ?? new Set();
    for (const p of eligibleHere) {
      if (submittedPlayers.has(p)) continue;
      const row = ensure(p);
      row.cells.set(n, { kind: 'dns' });
      if (row.eliminatedAt === null) row.eliminatedAt = n;
    }
  }

  const allRows = [...players.values()];
  const survivors = allRows
    .filter((row) => row.eliminatedAt === null)
    .sort((a, b) => caseInsensitive(a.player, b.player));
  const eliminatedRows = allRows
    .filter(
      (row): row is PlayerRow & { eliminatedAt: number } =>
        row.eliminatedAt !== null,
    )
    .sort((a, b) => {
      if (a.eliminatedAt !== b.eliminatedAt) {
        return b.eliminatedAt - a.eliminatedAt; // most-recent first
      }
      return caseInsensitive(a.player, b.player);
    });

  const orderedRows = [...survivors, ...eliminatedRows];

  const header = ['Player', ...rounds.map((r) => roundHeaderCell(r))];
  const separator = ['---', ...rounds.map(() => '---:')];
  const body = orderedRows.map((row) => {
    const isEliminated = row.eliminatedAt !== null;
    const safe = escapeMarkdownCell(row.player);
    const name = isEliminated ? `*${safe}*` : safe;
    const cells = rounds.map((r) =>
      renderCell(row.cells.get(r.roundInfo.number) ?? { kind: 'blank' }),
    );
    return [name, ...cells];
  });

  const lines: string[] = [];
  lines.push('# Américas TPG Gauntlet Leaderboard', '');
  lines.push('```geojson', JSON.stringify(targetsMap(rounds)), '```', '');
  lines.push(
    "Eliminated players shown in *italics*. Each cell contains the distance (in kilometers) for each player's submission.",
    '',
  );
  lines.push(formatRow(header));
  lines.push(formatRow(separator));
  for (const row of body) {
    lines.push(formatRow(row));
  }
  lines.push('');
  for (const round of rounds) {
    lines.push(roundLinkRef(round));
  }
  // ensure newline at end of file
  lines.push('');
  return lines.join('\n');
}

function roundHeaderCell(round: RoundFile): string {
  const n = round.roundInfo.number;
  return `[Round ${n}][r${n}]`;
}

function renderCell(cell: CellKind): string {
  switch (cell.kind) {
    case 'submitted': {
      const km = Math.round(cell.distanceKm);
      return cell.eliminatedHere ? `**${km}**` : String(km);
    }
    case 'dns':
      return 'DNS';
    case 'blank':
      return ' ';
  }
}

function formatRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

// Escape the characters that have structural meaning inside a markdown
// table cell. `|` ends a cell; `*` and `_` introduce emphasis (which then
// collides with the eliminated-player italic wrapper); `\` is the escape
// character itself. Player names are user-controlled, so this runs at
// every cell-emission site that interpolates a name.
function escapeMarkdownCell(value: string): string {
  return value.replace(/[\\|*_]/g, (ch) => `\\${ch}`);
}

function roundLinkRef(round: RoundFile): string {
  const n = round.roundInfo.number;
  const location = targetOf(round).properties.location;
  const link = submissionTrackerUrl(n);
  return `[r${n}]: ${link} "${location}"`;
}

function caseInsensitive(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  // Stable tie-break by code-point order so equal-when-lowered names
  // (e.g., 'alice' vs 'Alice') produce a deterministic order.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface GenerateLeaderboardDeps {
  roundsDir: string;
}

interface GenerateLeaderboardResult {
  markdown: string;
  rounds: number;
}

export async function generateLeaderboard(
  deps: GenerateLeaderboardDeps,
): Promise<GenerateLeaderboardResult> {
  const entries = await listRoundFiles(deps.roundsDir);
  const ended: RoundFile[] = [];
  for (const entry of entries) {
    const file = await readRound(entry.path);
    if (endedAtOf(file) !== null) ended.push(file);
  }
  if (ended.length === 0) {
    throw new Error('no ended rounds found');
  }
  const markdown = buildLeaderboardMarkdown(ended);
  return { markdown, rounds: ended.length };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'rounds-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const roundsDir = values['rounds-dir'] ?? DEFAULT_ROUNDS_DIR;
  const { markdown, rounds } = await generateLeaderboard({ roundsDir });
  await writeFile(DEFAULT_LEADERBOARD_PATH, markdown, 'utf8');
  process.stdout.write(
    `wrote ${DEFAULT_LEADERBOARD_PATH} (${rounds} round${rounds === 1 ? '' : 's'})\n`,
  );
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}
