import { mock } from 'node:test';
import type { SubmissionFeature } from '../src/round-domain.ts';

/** Stamp `eliminated: bool` on each submission — used for ended-round fixtures. */
export function withEliminated(
  subs: SubmissionFeature[],
  eliminatedPlayers: string[],
): SubmissionFeature[] {
  const e = new Set(eliminatedPlayers);
  return subs.map((s) => ({
    ...s,
    properties: { ...s.properties, eliminated: e.has(s.properties.player) },
  }));
}

/** 200 OK response whose body is `JSON.stringify(value)`. */
export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Response with a non-2xx status (or any status) and an optional plain body. */
export function statusResponse(
  status: number,
  body = '',
  init: Omit<ResponseInit, 'status'> = {},
): Response {
  return new Response(body, { status, ...init });
}

/** Adapt a `(url) => Response` handler into a `typeof fetch`. Use when a
 * subject-under-test accepts a `fetchImpl` injection. */
export function makeFetchStub(
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return async (input) =>
    handler(typeof input === 'string' ? input : String(input));
}

/** Install a `(url) => Response` handler as `globalThis.fetch` via
 * `mock.method`. Returns the node:test Mock so callers can assert call counts
 * and arguments. Pair with `afterEach(() => mock.restoreAll())`. */
export function mockGlobalFetch(
  handler: (url: string) => Response | Promise<Response>,
) {
  return mock.method(globalThis, 'fetch', makeFetchStub(handler));
}
