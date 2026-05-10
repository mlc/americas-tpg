import { pathToFileURL } from 'node:url';
import { RNG_NAMES, type RngName } from './rng.ts';

export type FailFn = (message: string) => never;

export function isMain(metaUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    metaUrl === pathToFileURL(process.argv[1]).href
  );
}

export function parseRound(
  raw: string | undefined,
  fail: FailFn,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
    return fail(
      `Invalid --round value: '${raw}'. Expected a positive integer.`,
    );
  }
  return n;
}

export function parseRng(
  raw: string | undefined,
  fail: FailFn,
  defaultRng: RngName = 'crypto',
): RngName {
  if (raw === undefined) return defaultRng;
  if ((RNG_NAMES as string[]).includes(raw)) return raw as RngName;
  return fail(
    `Invalid --rng value: '${raw}'. Expected one of: ${RNG_NAMES.join(', ')}.`,
  );
}
