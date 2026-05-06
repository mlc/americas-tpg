import { randomBytes } from 'node:crypto';
import { createRandomOrgRng } from './rng-random-org.ts';

export interface RandomSource {
  next(): Promise<number>;
}

const FIFTY_THREE_BIT_MASK = (1n << 53n) - 1n;
const TWO_TO_THE_53 = 2 ** 53;

const cryptoRandom: RandomSource = {
  async next(): Promise<number> {
    const bytes = randomBytes(7);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return Number(v & FIFTY_THREE_BIT_MASK) / TWO_TO_THE_53;
  },
};

const mathRandom: RandomSource = {
  async next(): Promise<number> {
    return Math.random();
  },
};

export type RngName = 'crypto' | 'math' | 'random.org';

export const rngFactories: Record<RngName, () => RandomSource> = {
  crypto: () => cryptoRandom,
  math: () => mathRandom,
  'random.org': () => createRandomOrgRng(),
};

export function createRng(name: RngName): RandomSource {
  return rngFactories[name]();
}
