import {
  eliminationsForRound,
  eliminationsFromFlags,
  endedAtOf,
  type RoundFile,
  submissionsOf,
} from './round-domain.ts';

export const SIMPLESTYLE = {
  TARGET_SYMBOL: 'star',
  TARGET_COLOR: '#000000',
  PLAYER_SYMBOL: 'circle',
  GOLD: '#d4af37',
  SILVER: '#c0c0c0',
  BRONZE: '#cd7f32',
  LAST: '#ff0000',
  DEFAULT_PLAYER: '#444444',
} as const;

const PODIUM_COLORS = [
  SIMPLESTYLE.GOLD,
  SIMPLESTYLE.SILVER,
  SIMPLESTYLE.BRONZE,
] as const;

export function playerMarkerColor(rankIndex: number, isLast: boolean): string {
  if (isLast) return SIMPLESTYLE.LAST;
  return PODIUM_COLORS[rankIndex] ?? SIMPLESTYLE.DEFAULT_PLAYER;
}

/**
 * Returns a copy of the round with simplestyle-spec marker-symbol/marker-color
 * properties applied to the target and every submission. Always recomputes
 * marker style from scratch — any styling already on the input is overwritten.
 *
 * The eliminated set comes from the persisted `eliminated === true` flags on
 * ended rounds (post-honest-DNS-rule answer), and from `eliminationsForRound`
 * on in-progress rounds where the flags aren't stamped yet. This keeps the
 * marker color (red for eliminated) consistent with the round's actual
 * outcome — a player saved by the honest-DNS rule has `eliminated: false`
 * on disk, so they correctly render in non-red.
 */
export function applySimplestyle(round: RoundFile): RoundFile {
  const subs = submissionsOf(round);
  const eliminations =
    endedAtOf(round) === null
      ? eliminationsForRound(round)
      : eliminationsFromFlags(round);
  const sorted = subs.toSorted(
    (a, b) => a.properties.distance - b.properties.distance,
  );
  const rankByPlayer = new Map<string, number>(
    sorted.map((s, i) => [s.properties.player, i]),
  );

  const target = round.features[0];
  const styledTarget = {
    ...target,
    properties: {
      ...target.properties,
      'marker-symbol': SIMPLESTYLE.TARGET_SYMBOL,
      'marker-color': SIMPLESTYLE.TARGET_COLOR,
    },
  };
  const styledSubs = subs.map((sub) => {
    const player = sub.properties.player;
    const rank = rankByPlayer.get(player) ?? Number.POSITIVE_INFINITY;
    const color = playerMarkerColor(rank, eliminations.has(player));
    return {
      ...sub,
      properties: {
        ...sub.properties,
        'marker-symbol': SIMPLESTYLE.PLAYER_SYMBOL,
        'marker-color': color,
      },
    };
  });
  return {
    ...round,
    features: [styledTarget, ...styledSubs],
  } as RoundFile;
}
