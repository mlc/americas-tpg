import type { Position } from 'geojson';

const DEFAULT_BASE_URL = 'https://tpg.marsmathis.com/api';
const DEFAULT_TIMEOUT_MS = 15_000;

export type MorphiorErrorKind = 'timeout' | 'status' | 'parse' | 'transport';

/**
 * Error type for MorphiorDB client failures. Tagged via `.kind` so callers
 * can discriminate without parsing message strings.
 */
export class MorphiorDbError extends Error {
  readonly kind: MorphiorErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: MorphiorErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'MorphiorDbError';
    this.kind = kind;
    this.status = options.status;
  }
}

export function isMorphiorDbError(err: unknown): err is MorphiorDbError {
  return err instanceof MorphiorDbError;
}

function makeError(
  kind: MorphiorErrorKind,
  message: string,
  options: { status?: number; cause?: unknown } = {},
): MorphiorDbError {
  return new MorphiorDbError(kind, message, options);
}

export interface MorphiorPlayer {
  readonly discord_id: string;
  readonly canonical_name: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface MorphiorClient {
  /**
   * Find every MorphiorDB record whose `canonical_name`, `name`, or any
   * alias exact-matches the query (case-insensitive). The fuzzy `?q=`
   * search is a starting point; the strict match avoids accidentally
   * pulling another player's history. Returns `[]` for no matches and a
   * length-N array for N matches — callers can discriminate `notFound`
   * from `ambiguous` by inspecting the length.
   */
  findPlayers(name: string): Promise<readonly MorphiorPlayer[]>;
  /**
   * Fetch all unique submission points for a Discord ID. Returns `[lon, lat]`
   * pairs in the API's natural order. Empty array for unknown IDs (the API
   * returns HTTP 200 with `[]`, not 404).
   */
  fetchSubmissions(discordId: string): Promise<readonly Position[]>;
}

export interface MorphiorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function openMorphiorClient(
  options: MorphiorClientOptions = {},
): MorphiorClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async findPlayers(name) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return [];
      const url = `${baseUrl}/players?q=${encodeURIComponent(trimmed)}`;
      const data = await fetchJson(fetchImpl, url, timeoutMs, 'players');
      if (!Array.isArray(data)) {
        throw makeError(
          'parse',
          `morphiordb /players: expected array response, got ${typeof data}`,
        );
      }
      return data
        .filter(isPlayerObject)
        .filter((row) => playerMatchesExact(row, trimmed));
    },
    async fetchSubmissions(discordId) {
      const url = `${baseUrl}/submissions/${encodeURIComponent(discordId)}`;
      const data = await fetchJson(fetchImpl, url, timeoutMs, 'submissions');
      if (!Array.isArray(data)) {
        throw makeError(
          'parse',
          `morphiordb /submissions/{id}: expected array response, got ${typeof data}`,
        );
      }
      const points: Position[] = [];
      for (const row of data) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        if (typeof r.lat !== 'number' || !Number.isFinite(r.lat)) continue;
        if (typeof r.lon !== 'number' || !Number.isFinite(r.lon)) continue;
        points.push([r.lon, r.lat]);
      }
      return points;
    },
  };
}

function isPlayerObject(value: unknown): value is MorphiorPlayer {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.discord_id !== 'string') return false;
  if (typeof v.canonical_name !== 'string') return false;
  if (typeof v.name !== 'string') return false;
  if (!Array.isArray(v.aliases)) return false;
  return v.aliases.every((a) => typeof a === 'string');
}

function normalizeForCompare(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase();
}

function playerMatchesExact(player: MorphiorPlayer, query: string): boolean {
  const q = normalizeForCompare(query);
  if (normalizeForCompare(player.canonical_name) === q) return true;
  if (normalizeForCompare(player.name) === q) return true;
  return player.aliases.some((a) => normalizeForCompare(a) === q);
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  endpointLabel: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw makeError(
        'timeout',
        `morphiordb /${endpointLabel}: request timed out after ${timeoutMs} ms`,
        { cause },
      );
    }
    throw makeError(
      'transport',
      `morphiordb /${endpointLabel}: transport failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw makeError(
      'status',
      `morphiordb /${endpointLabel}: HTTP ${response.status} ${response.statusText}${detail ? ` -- ${detail}` : ''}`,
      { status: response.status },
    );
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw makeError(
      'transport',
      `morphiordb /${endpointLabel}: response body read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw makeError(
      'parse',
      `morphiordb /${endpointLabel}: invalid JSON response: ${body.slice(0, 200)}`,
      { cause },
    );
  }
}
