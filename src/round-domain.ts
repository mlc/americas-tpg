import { distance } from '@turf/distance';
import type { Feature, Point, Position } from 'geojson';
import { formatCoords } from './format.ts';
import { mainCountryName, roundLabel } from './language.ts';

export const TIE_BUFFER_KM = 0.025;

const ZERO_WIDTH_RE = /[​-‍﻿]/g;

/**
 * Normalize a player name: NFC + strip zero-width chars + trim.
 * Player-name comparison is otherwise byte-exact (case-sensitive).
 */
export function normalizePlayerName(raw: string): string {
  return raw.normalize('NFC').replace(ZERO_WIDTH_RE, '').trim();
}

export interface RoundInfo {
  number: number;
  endedAt: string | null;
  language?: string;
  /** Per-DNS-player rule evaluations from the honest-DNS save rule.
   * Present iff the round is ended; the validator enforces both directions
   * (presence-iff-ended). See CLAUDE.md "Honest-DNS save rule" subsection. */
  dnsChecks?: DnsCheck[];
}

export interface RoundFile {
  type: 'FeatureCollection';
  roundInfo: RoundInfo;
  features: ReadonlyArray<RoundFeature>;
}

export type RoundFeature = TargetFeature | SubmissionFeature;

export interface TargetFeature extends Feature<Point, { location: string }> {
  id: 'target';
}

export function targetOf(round: RoundFile): TargetFeature {
  const target = round.features[0];
  if (!target || target.id !== 'target') {
    throw new Error('round file is missing target at features[0]');
  }
  return target;
}

export function endedAtOf(round: RoundFile): string | null {
  return round.roundInfo.endedAt;
}

export type SubmissionFeature = Feature<
  Point,
  {
    player: string;
    distance: number;
    location?: string;
    // Stamped on every submission when the round is ended (via end-round).
    // Absent on in-progress rounds. The validator enforces both directions.
    eliminated?: boolean;
  }
> & { id?: never };

export function submissionsOf(round: RoundFile): readonly SubmissionFeature[] {
  return round.features.slice(1) as SubmissionFeature[];
}

export function submitters(round: RoundFile): readonly string[] {
  return submissionsOf(round).map((s) => s.properties.player);
}

export function eliminationsForRound(round: RoundFile): ReadonlySet<string> {
  const subs = submissionsOf(round);
  if (subs.length === 0) return new Set();
  const max = Math.max(...subs.map((s) => s.properties.distance));
  return new Set(
    subs
      .filter((s) => max - s.properties.distance < TIE_BUFFER_KM)
      .map((s) => s.properties.player),
  );
}

/**
 * Read the round's eliminated set from persisted `eliminated === true` flags
 * on submissions — the post-save-rule answer that's authoritative on disk.
 * Used by `endRound`'s re-end branch and any other consumer that needs the
 * after-rule eliminations once it's been stamped. The first-run branch still
 * derives its initial eliminations from `eliminationsForRound`, then mutates
 * the disk flags to reflect any save.
 */
export function eliminationsFromFlags(round: RoundFile): ReadonlySet<string> {
  return new Set(
    submissionsOf(round)
      .filter((s) => s.properties.eliminated === true)
      .map((s) => s.properties.player),
  );
}

/**
 * The honest-DNS save rule. Given the distance-derived elimination set and
 * the per-DNS evaluations, return the set of submitters to spare. The set is
 * non-empty iff at least one DNS player could not have escaped (an "honest
 * DNS" who triggers the save). Spared players are exactly the round's
 * distance-derived eliminations — the rule absorbs the round's elimination
 * slot via the DNS instead.
 */
export function applyDnsSaveRule(
  eliminations: ReadonlySet<string>,
  dnsChecks: readonly DnsCheck[],
): ReadonlySet<string> {
  const honest = dnsChecks.some((c) => !c.couldHaveEscaped);
  return honest ? new Set(eliminations) : new Set();
}

/**
 * Persisted record describing the rule's evaluation of one DNS player.
 * Lives at `roundInfo.dnsChecks[i]` on ended rounds; the validator enforces
 * presence-iff-ended and the field-shape invariants documented in
 * CLAUDE.md.
 */
export interface DnsCheck {
  player: string;
  /** The closest historical submission to the current target — its
   * `[lon, lat]` and `distanceKm` — or `null` when the player has no
   * available history (anti-ghost case). The pair is structurally bundled
   * so the type system enforces the "both populated or both null" invariant. */
  best: { point: Position; distanceKm: number } | null;
  couldHaveEscaped: boolean;
  /** `ok` — exactly one MorphiorDB record matched and submissions fetched;
   * `noMatch` — zero or multiple exact matches (the rule falls back to
   * local-only history either way); `unavailable` — any HTTP / network /
   * parse failure. The two non-`ok` outcomes are behaviorally identical
   * for the rule but kept distinct for operator audits. */
  morphiorDbStatus: 'ok' | 'noMatch' | 'unavailable';
  /** Parse-survivor count of submission rows when status === 'ok'; null
   * otherwise. Reflects rows the parser kept (with finite lat/lon), not
   * raw API row count — see CLAUDE.md "Honest-DNS save rule" subsection. */
  morphiorDbSubmissionCount: number | null;
}

/**
 * Pure rule evaluator. Given a DNS player's pool of historical submission
 * points and the current round's worst real-submission distance, decide
 * whether the player could have escaped elimination.
 *
 * Empty `points` → `couldHaveEscaped: true` (anti-ghost: a player with no
 * history available anywhere never triggers a save). Non-empty: the closest
 * historical point to the target sets `bestDistanceKm`. The escape predicate
 * is `bestDistanceKm < currentMaxKm − TIE_BUFFER_KM` — strict `<`, mirroring
 * `eliminationsForRound`'s `max − distance < TIE_BUFFER_KM` so the boundary
 * semantics align exactly.
 */
export function evaluateDnsCheck(
  target: Position,
  points: readonly Position[],
  currentMaxKm: number,
): Pick<DnsCheck, 'best' | 'couldHaveEscaped'> {
  if (points.length === 0) {
    return { best: null, couldHaveEscaped: true };
  }
  let bestPoint = points[0];
  let bestDistanceKm = distance(target, bestPoint, { units: 'kilometers' });
  for (let i = 1; i < points.length; i++) {
    const d = distance(target, points[i], { units: 'kilometers' });
    if (d < bestDistanceKm) {
      bestDistanceKm = d;
      bestPoint = points[i];
    }
  }
  return {
    best: { point: bestPoint, distanceKm: bestDistanceKm },
    couldHaveEscaped: bestDistanceKm < currentMaxKm - TIE_BUFFER_KM,
  };
}

export interface EligibilityCheck {
  player: string;
  currentRound: RoundFile;
  currentRoundNumber: number;
  prevRound: RoundFile | null;
  force?: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function validateSubmissionEligibility({
  player,
  currentRound,
  currentRoundNumber,
  prevRound,
  force,
}: EligibilityCheck): EligibilityResult {
  if (endedAtOf(currentRound) !== null) {
    return {
      eligible: false,
      reason: `round ${currentRoundNumber} is ended; submissions are closed`,
    };
  }
  if (force) return { eligible: true };
  if (prevRound === null) return { eligible: true };
  // prevRound must be ended — only ended rounds carry the `eliminated` flag
  // that the eligibility check trusts. Guard the precondition explicitly so
  // an in-progress prev (which the file validator accepts as valid) doesn't
  // silently look like "everyone eliminated."
  if (endedAtOf(prevRound) === null) {
    throw new Error(
      `validateSubmissionEligibility: prevRound (round ${currentRoundNumber - 1}) must be ended`,
    );
  }
  const eligible = new Set(
    submissionsOf(prevRound)
      .filter((s) => s.properties.eliminated === false)
      .map((s) => s.properties.player),
  );
  if (eligible.has(player)) return { eligible: true };
  const sorted = [...eligible].sort();
  const list = sorted.length === 0 ? '(none)' : sorted.join(', ');
  return {
    eligible: false,
    reason: `player '${player}' not eligible for round ${currentRoundNumber}. Eligible: ${list}`,
  };
}

export function formatLocation(props: {
  gid_0?: string | null;
  name_0?: string | null;
  name_1?: string | null;
}): string | null {
  const country = mainCountryName(props.gid_0 ?? undefined) ?? props.name_0;
  if (!country) return null;
  if (props.name_1) return `${props.name_1}, ${country}`;
  return country;
}

export function formatTargetDiscord(file: RoundFile): string {
  const target = targetOf(file);
  const [lon, lat] = target.geometry.coordinates;
  const params = new URLSearchParams({
    api: '1',
    query: `${lat},${lon}`,
  });
  const url = `https://www.google.com/maps/search/?${params}`;
  const coords = formatCoords(target.geometry.coordinates);
  const word = roundLabel(file.roundInfo.language);
  return `# ${word} ${file.roundInfo.number}, ${target.properties.location}, [${coords}](${url})`;
}

export function formatStandings(round: RoundFile): string {
  const subs = submissionsOf(round);
  if (subs.length === 0) {
    return 'Standings:\n  (no submissions)';
  }
  const sorted = [...subs].sort(
    (a, b) => a.properties.distance - b.properties.distance,
  );
  const lines = sorted.map((s, i) => {
    const rank = String(i + 1).padStart(2);
    const distance = `${s.properties.distance.toFixed(3)} km`;
    return `  ${rank}. ${s.properties.player}  ${distance}`;
  });
  return ['Standings:', ...lines].join('\n');
}
