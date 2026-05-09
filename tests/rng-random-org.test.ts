import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { createRandomOrgRng } from '../src/rng-random-org.ts';
import { mockGlobalFetch, statusResponse } from './test-helpers.ts';

afterEach(() => {
  mock.restoreAll();
});

function bodyOf(values: number[]): string {
  return `${values.map((v) => v.toFixed(20)).join('\n')}\n`;
}

describe('createRandomOrgRng — happy path', () => {
  test('first next() fetches once and returns the first value', async () => {
    const fetchMock = mockGlobalFetch(
      () => new Response(bodyOf([0.1, 0.2, 0.3])),
    );
    const rng = createRandomOrgRng();
    assert.equal(await rng.next(), 0.1);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test('subsequent next() calls drain the buffer without re-fetching', async () => {
    const fetchMock = mockGlobalFetch(
      () => new Response(bodyOf([0.1, 0.2, 0.3])),
    );
    const rng = createRandomOrgRng();
    assert.equal(await rng.next(), 0.1);
    assert.equal(await rng.next(), 0.2);
    assert.equal(await rng.next(), 0.3);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test('refetches when the buffer empties', async () => {
    const responses = [bodyOf([0.5]), bodyOf([0.7, 0.8])];
    let i = 0;
    const fetchMock = mockGlobalFetch(() => new Response(responses[i++]));
    const rng = createRandomOrgRng();
    assert.equal(await rng.next(), 0.5);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(await rng.next(), 0.7);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(await rng.next(), 0.8);
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  test('hits the configured endpoint with the expected query parameters', async () => {
    const fetchMock = mockGlobalFetch(() => new Response(bodyOf([0.42])));
    await createRandomOrgRng().next();
    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.match(url, /^https:\/\/www\.random\.org\/decimal-fractions\//);
    assert.match(url, /num=200\b/);
    assert.match(url, /dec=20\b/);
    assert.match(url, /format=plain\b/);
  });
});

describe('createRandomOrgRng — error handling', () => {
  test('non-2xx response → descriptive error including status', async () => {
    mockGlobalFetch(() =>
      statusResponse(503, 'rate limited bro', {
        statusText: 'Service Unavailable',
      }),
    );
    await assert.rejects(
      createRandomOrgRng().next(),
      /random\.org request failed: 503 Service Unavailable.*rate limited bro/,
    );
  });

  test('empty body → unparseable error', async () => {
    mockGlobalFetch(() => new Response('   \n  \n'));
    await assert.rejects(createRandomOrgRng().next(), /unparseable response/);
  });

  test('non-numeric body → unparseable error', async () => {
    mockGlobalFetch(() => new Response('not-a-number\nalso-bad\n'));
    await assert.rejects(createRandomOrgRng().next(), /unparseable response/);
  });

  test('TimeoutError surfaces as a "timed out" error', async () => {
    mockGlobalFetch(() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    await assert.rejects(
      createRandomOrgRng().next(),
      /random\.org request timed out after 15000 ms/,
    );
  });

  test('other transport failures are wrapped with "(transport)"', async () => {
    mockGlobalFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(
      createRandomOrgRng().next(),
      /random\.org request failed \(transport\): ECONNREFUSED/,
    );
  });
});
