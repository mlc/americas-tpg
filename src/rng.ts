import { randomBytes } from 'node:crypto';
import { RngRandomOrg } from './rng-random-org.ts';

export type RandomSource = AsyncIterator<number, never, never>;

const FIFTY_THREE_BIT_MASK = (1n << 53n) - 1n;
const TWO_TO_THE_53 = 2 ** 53;

const cryptoRandom: RandomSource = {
  next: async () => {
    const bytes = randomBytes(8);
    bytes[0] = 0x3f;
    bytes[1] = (bytes[1] & 0xf) | 0xf0;
    return { value: bytes.readDoubleBE() - 1.0, done: false };
  },
  return: () => Promise.reject(new Error('not supported')),
  throw: (e?: any) => Promise.reject(e),
};

const mathRandom: RandomSource = {
  next: async () => {
    return { value: Math.random(), done: false };
  },
  return: () => Promise.reject(new Error('not supported')),
  throw: (e?: any) => Promise.reject(e),
};

export type RngName = 'crypto' | 'math' | 'random.org';

export const rngFactories: Record<RngName, () => RandomSource> = {
  crypto: () => cryptoRandom,
  math: () => mathRandom,
  'random.org': () => new RngRandomOrg(),
};

export const RNG_NAMES = Object.keys(rngFactories) as RngName[];

export function createRng(name: RngName): RandomSource {
  return rngFactories[name]();
}
