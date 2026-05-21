import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Position } from 'geojson';
import { endedAtOf, type RoundFile, submissionsOf } from './round-domain.ts';
import { validateRoundFile } from './round-validate.ts';
import { applySimplestyle } from './simplestyle.ts';

export const DEFAULT_ROUNDS_DIR = 'rounds';

const ROUND_FILE_RE = /^(\d{3,})\.geojson$/;

export function roundPath(
  round: number,
  dir: string = DEFAULT_ROUNDS_DIR,
): string {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`invalid round number: ${round}`);
  }
  return join(dir, `${String(round).padStart(3, '0')}.geojson`);
}

export function parseRoundNumber(filename: string): number | null {
  const match = ROUND_FILE_RE.exec(basename(filename));
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return n >= 1 ? n : null;
}

export interface RoundEntry {
  round: number;
  path: string;
}

export async function listRoundFiles(
  dir: string = DEFAULT_ROUNDS_DIR,
): Promise<RoundEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  const rounds: RoundEntry[] = [];
  for (const entry of entries) {
    const n = parseRoundNumber(entry);
    if (n !== null) rounds.push({ round: n, path: join(dir, entry) });
  }
  rounds.sort((a, b) => a.round - b.round);
  return rounds;
}

export interface RoundLookup {
  entry: RoundEntry;
  file: RoundFile;
}

export async function findLatestRound(
  dir: string = DEFAULT_ROUNDS_DIR,
): Promise<RoundLookup | null> {
  const rounds = await listRoundFiles(dir);
  if (rounds.length === 0) return null;
  const last = rounds[rounds.length - 1];
  const file = await readRound(last.path);
  return { entry: last, file };
}

export async function findActiveRound(
  dir: string = DEFAULT_ROUNDS_DIR,
): Promise<RoundLookup | null> {
  // Invariant: an active round can only be the latest one — createRound refuses
  // to start a new round while any prior round is unended (R15).
  const latest = await findLatestRound(dir);
  if (!latest || endedAtOf(latest.file) !== null) return null;
  return latest;
}

/**
 * Collect every submission point a named player has on disk across the
 * game's ended rounds. In-progress rounds are skipped (they're not history
 * yet); `excludeRound` skips the round currently closing so the round being
 * ended doesn't bias its own DNS check.
 *
 * Returns one `[lon, lat]` per matching submission feature, in
 * round-then-feature order. Duplicates are kept; min-distance-style
 * consumers don't care.
 *
 * Player-name comparison is byte-exact, post-NFC — matching the
 * `normalizePlayerName` identity model used elsewhere.
 */
export async function listSubmissionsForPlayer(
  player: string,
  dir: string = DEFAULT_ROUNDS_DIR,
  opts: { excludeRound?: number } = {},
): Promise<Position[]> {
  const rounds = await listRoundFiles(dir);
  const points: Position[] = [];
  for (const entry of rounds) {
    if (opts.excludeRound !== undefined && entry.round === opts.excludeRound) {
      continue;
    }
    const round = await readRound(entry.path);
    if (endedAtOf(round) === null) continue;
    for (const sub of submissionsOf(round)) {
      if (sub.properties.player === player) {
        points.push(sub.geometry.coordinates);
      }
    }
  }
  return points;
}

export interface ResolveRoundOptions {
  roundsDir: string;
  explicitRound?: number;
  missingMessage?: string;
}

export async function resolveRound(
  opts: ResolveRoundOptions,
): Promise<RoundLookup> {
  if (opts.explicitRound !== undefined) {
    const path = roundPath(opts.explicitRound, opts.roundsDir);
    const file = await readRound(path);
    return { entry: { round: opts.explicitRound, path }, file };
  }
  const active = await findActiveRound(opts.roundsDir);
  if (!active) {
    throw new Error(opts.missingMessage ?? 'no active round');
  }
  return active;
}

export async function readRound(path: string): Promise<RoundFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`round file not found: ${path}`);
    }
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `round file ${path}: invalid JSON (${(cause as Error).message})`,
    );
  }
  return validateRoundFile(parsed, path);
}

export async function writeRoundAtomic(
  path: string,
  file: RoundFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const styled = applySimplestyle(file);
  const sorted: RoundFile = {
    ...styled,
    features: [
      styled.features[0],
      ...submissionsOf(styled).toSorted(
        (a, b) => a.properties.distance - b.properties.distance,
      ),
    ],
  };
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  try {
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, path);
  } catch (cause) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup; ignore failures (file may not exist)
    }
    throw cause;
  }
}
