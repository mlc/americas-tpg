import type { RandomSource } from './rng.ts';

const ENDPOINT = 'https://www.random.org/decimal-fractions/';
const CHUNK_SIZE = 200;
const DECIMAL_PLACES = 20;

async function fetchChunk(): Promise<number[]> {
  const url =
    `${ENDPOINT}?num=${CHUNK_SIZE}&dec=${DECIMAL_PLACES}&col=1&format=plain&rnd=new`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `random.org request failed: ${response.status} ${response.statusText}`,
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

export function createRandomOrgRng(): RandomSource {
  const buffer: number[] = [];
  return {
    async next(): Promise<number> {
      if (buffer.length === 0) {
        const chunk = await fetchChunk();
        buffer.push(...chunk);
      }
      const value = buffer.shift();
      if (value === undefined) {
        throw new Error('random.org buffer empty after refill');
      }
      return value;
    },
  };
}
