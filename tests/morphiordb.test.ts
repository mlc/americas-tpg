import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isMorphiorDbError,
  type MorphiorClientOptions,
  openMorphiorClient,
} from '../src/morphiordb.ts';

const ANZA = {
  discord_id: '986253216096342107',
  canonical_name: 'motivation0',
  name: 'Anza',
  aliases: ['Anza', 'motivation0'],
};

const TENDER = {
  discord_id: '1349850626976382976',
  canonical_name: 'tenderman96',
  name: 'TENDERMAN96 | xo mobile 100%',
  aliases: ['TENDERMAN96 | xo mobile 100%', 'tenderman96'],
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function statusResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return async (input) =>
    handler(typeof input === 'string' ? input : String(input));
}

function makeClient(
  handler: (url: string) => Response,
  overrides: MorphiorClientOptions = {},
) {
  return openMorphiorClient({
    baseUrl: 'https://example.test/api',
    timeoutMs: 1_000,
    fetchImpl: stubFetch(handler),
    ...overrides,
  });
}

describe('openMorphiorClient — findPlayer', () => {
  test('exact case-insensitive alias match returns the player', async () => {
    const client = makeClient((url) => {
      assert.equal(url, 'https://example.test/api/players?q=anza');
      return jsonResponse([ANZA]);
    });
    const result = await client.findPlayer('anza');
    assert.deepEqual(result, ANZA);
  });

  test('exact case-insensitive name match returns the player', async () => {
    const client = makeClient(() => jsonResponse([TENDER]));
    const result = await client.findPlayer('TENDERMAN96 | xo mobile 100%');
    assert.deepEqual(result, TENDER);
  });

  test('exact case-insensitive canonical_name match returns the player', async () => {
    const client = makeClient(() => jsonResponse([ANZA]));
    const result = await client.findPlayer('MOTIVATION0');
    assert.deepEqual(result, ANZA);
  });

  test('empty result array → null', async () => {
    const client = makeClient(() => jsonResponse([]));
    assert.equal(await client.findPlayer('Nonexistent'), null);
  });

  test('multiple results, none exact-matching → null', async () => {
    // Players whose name/canonical_name/aliases all only fuzzy-match the query.
    const client = makeClient(() =>
      jsonResponse([
        {
          discord_id: '1',
          canonical_name: 'anzafuzz',
          name: 'AnzaFuzz',
          aliases: ['anzafuzz'],
        },
        {
          discord_id: '2',
          canonical_name: 'anzatron',
          name: 'AnzaTron',
          aliases: ['anzatron'],
        },
      ]),
    );
    assert.equal(await client.findPlayer('anza'), null);
  });

  test('multiple results, two exact matches → null (ambiguous)', async () => {
    const client = makeClient(() =>
      jsonResponse([ANZA, { ...TENDER, name: 'Anza' }]),
    );
    assert.equal(await client.findPlayer('Anza'), null);
  });

  test('substring match without exact match → null', async () => {
    const client = makeClient(() => jsonResponse([ANZA]));
    // ?q=anz is a fuzzy prefix that the server returns Anza for, but our
    // strict filter requires the query equal canonical_name/name/alias.
    assert.equal(await client.findPlayer('anz'), null);
  });

  test('empty / whitespace name → null without HTTP call', async () => {
    let called = false;
    const client = makeClient(() => {
      called = true;
      return jsonResponse([]);
    });
    assert.equal(await client.findPlayer('   '), null);
    assert.equal(called, false);
  });

  test('drops player rows whose schema is malformed', async () => {
    const client = makeClient(() =>
      jsonResponse([
        { discord_id: 'x', canonical_name: 'x', name: 'x' }, // missing aliases
        ANZA,
      ]),
    );
    assert.deepEqual(await client.findPlayer('Anza'), ANZA);
  });

  test('non-array response → MorphiorDbError(parse)', async () => {
    const client = makeClient(() => jsonResponse({ players: [] }));
    await assert.rejects(client.findPlayer('Anza'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'parse');
      return true;
    });
  });
});

describe('openMorphiorClient — fetchSubmissions', () => {
  test('returns array of [lon, lat] points', async () => {
    const client = makeClient((url) => {
      assert.equal(
        url,
        'https://example.test/api/submissions/986253216096342107',
      );
      return jsonResponse([
        { discord_id: ANZA.discord_id, lat: 53.56, lon: -9.89, count: 1 },
        { discord_id: ANZA.discord_id, lat: 50.03, lon: 19.18, count: 1 },
      ]);
    });
    const points = await client.fetchSubmissions(ANZA.discord_id);
    assert.deepEqual(points, [
      [-9.89, 53.56],
      [19.18, 50.03],
    ]);
  });

  test('empty array (unknown discord_id) → []', async () => {
    const client = makeClient(() => jsonResponse([]));
    assert.deepEqual(await client.fetchSubmissions('0'), []);
  });

  test('skips rows with non-numeric or missing lat/lon', async () => {
    const client = makeClient(() =>
      jsonResponse([
        { lat: 1, lon: 2 },
        { lat: 'bad' },
        { lon: 3 },
        { lat: Number.NaN, lon: 4 },
        null,
        { lat: 5, lon: 6 },
      ]),
    );
    assert.deepEqual(await client.fetchSubmissions('x'), [
      [2, 1],
      [6, 5],
    ]);
  });

  test('non-array response → MorphiorDbError(parse)', async () => {
    const client = makeClient(() => jsonResponse({ rows: [] }));
    await assert.rejects(client.fetchSubmissions('x'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'parse');
      return true;
    });
  });
});

describe('openMorphiorClient — error mapping', () => {
  test('HTTP 500 → MorphiorDbError(status) with status code', async () => {
    const client = makeClient(() => statusResponse(500, 'boom'));
    await assert.rejects(client.findPlayer('Anza'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'status');
      assert.equal(err.status, 500);
      return true;
    });
  });

  test('HTTP 404 → MorphiorDbError(status) with status code', async () => {
    const client = makeClient(() => statusResponse(404));
    await assert.rejects(client.fetchSubmissions('x'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'status');
      assert.equal(err.status, 404);
      return true;
    });
  });

  test('malformed JSON → MorphiorDbError(parse)', async () => {
    const client = makeClient(
      () => new Response('{ not json', { status: 200 }),
    );
    await assert.rejects(client.findPlayer('Anza'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'parse');
      return true;
    });
  });

  test('transport failure → MorphiorDbError(transport)', async () => {
    const client = makeClient(() => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(client.findPlayer('Anza'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'transport');
      return true;
    });
  });

  test('AbortSignal.timeout error → MorphiorDbError(timeout)', async () => {
    const client = makeClient(() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    await assert.rejects(client.findPlayer('Anza'), (err: unknown) => {
      assert.ok(isMorphiorDbError(err));
      assert.equal(err.kind, 'timeout');
      return true;
    });
  });
});

describe('isMorphiorDbError', () => {
  test('returns false for plain Errors and non-errors', () => {
    assert.equal(isMorphiorDbError(new Error('plain')), false);
    assert.equal(isMorphiorDbError(null), false);
    assert.equal(isMorphiorDbError({ kind: 'timeout' }), false);
  });
});
