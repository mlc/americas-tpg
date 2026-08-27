import type { RandomSource } from './rng.ts';

const ENDPOINT = 'https://www.random.org/decimal-fractions/';
const CHUNK_SIZE = 200;
const DECIMAL_PLACES = 20;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchChunk(): Promise<number[]> {
  const params = new URLSearchParams({
    num: String(CHUNK_SIZE),
    dec: String(DECIMAL_PLACES),
    col: '1',
    format: 'plain',
    rnd: 'new',
  });
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new Error(
        `random.org request timed out after ${REQUEST_TIMEOUT_MS} ms`,
      );
    }
    throw new Error(
      `random.org request failed (transport): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new Error(
      `random.org request failed: ${response.status} ${response.statusText}${detail ? ` -- ${detail}` : ''}`,
    );
  }
  const body = await response.text();
  const values = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseFloat(line));
  if (values.length === 0 || values.some((v) => Number.isNaN(v))) {
    throw new Error(
      `random.org returned an unparseable response: ${body.slice(0, 200)}`,
    );
  }
  return values;
}

export class RngRandomOrg implements RandomSource {
  private buffer: number[] = [];

  async next(): Promise<{ value: number; done: false }> {
    if (this.buffer.length === 0) {
      const chunk = await fetchChunk();
      this.buffer.push(...chunk);
    }
    const value = this.buffer.shift();
    if (value === undefined) {
      throw new Error('random.org buffer empty after refill');
    }
    return { value, done: false };
  }

  return() {
    return Promise.reject('not supported');
  }

  throw(e: any) {
    return Promise.reject(e);
  }
}
