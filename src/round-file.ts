import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RoundFile } from './round-domain.ts';

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
  return Number.parseInt(match[1], 10);
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
  const rounds = await listRoundFiles(dir);
  for (let i = rounds.length - 1; i >= 0; i--) {
    const entry = rounds[i];
    const file = await readRound(entry.path);
    if (file.properties.ended_at === null) return { entry, file };
  }
  return null;
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
  const json = `${JSON.stringify(file, null, 2)}\n`;
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

function validateRoundFile(data: unknown, path: string): RoundFile {
  function fail(msg: string): never {
    throw new Error(`round file ${path}: ${msg}`);
  }
  if (!data || typeof data !== 'object') fail('not an object');
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'FeatureCollection') {
    fail("type must be 'FeatureCollection'");
  }
  const props = obj.properties;
  if (!props || typeof props !== 'object') {
    fail('missing top-level properties');
  }
  const propsObj = props as Record<string, unknown>;
  if (!Number.isInteger(propsObj.round) || (propsObj.round as number) < 1) {
    fail('properties.round must be a positive integer');
  }
  const endedAt = propsObj.ended_at;
  if (endedAt !== null && typeof endedAt !== 'string') {
    fail('properties.ended_at must be null or an ISO 8601 string');
  }
  if (typeof endedAt === 'string' && Number.isNaN(Date.parse(endedAt))) {
    fail('properties.ended_at is not a valid ISO 8601 string');
  }
  if (!Array.isArray(obj.features)) fail('features must be an array');
  const features = obj.features as unknown[];
  if (features.length === 0) {
    fail('features array is empty (target required at index 0)');
  }
  const target = features[0];
  if (!target || typeof target !== 'object') {
    fail('features[0] is not an object');
  }
  const targetObj = target as Record<string, unknown>;
  if (targetObj.id !== 'target') {
    fail(
      `features[0] must have id: "target" (got ${JSON.stringify(targetObj.id)})`,
    );
  }
  const targetProps = targetObj.properties as
    | Record<string, unknown>
    | undefined;
  if (targetProps && 'player' in targetProps) {
    fail('features[0] (target) must not have a player property');
  }
  for (let i = 1; i < features.length; i++) {
    const sub = features[i];
    if (!sub || typeof sub !== 'object') {
      fail(`features[${i}] is not an object`);
    }
    const subPropsRaw = (sub as { properties?: unknown }).properties;
    if (!subPropsRaw || typeof subPropsRaw !== 'object') {
      fail(`features[${i}] must have properties (object)`);
    }
    const subProps = subPropsRaw as Record<string, unknown>;
    if (typeof subProps.player !== 'string') {
      fail(`features[${i}] must have properties.player (string)`);
    }
    if (typeof subProps.distance !== 'number') {
      fail(`features[${i}] must have properties.distance (number)`);
    }
  }
  return data as RoundFile;
}
