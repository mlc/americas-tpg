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
