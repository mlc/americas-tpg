import type { Feature, Point } from 'geojson';
import { formatCoords } from './format.ts';
import { mainCountryName } from './language.ts';

export const TIE_BUFFER_KM = 0.025;

const ZERO_WIDTH_RE = /[​-‍﻿]/g;

/**
 * Normalize a player name: NFC + strip zero-width chars + trim.
 * Player-name comparison is otherwise byte-exact (case-sensitive).
 */
export function normalizePlayerName(raw: string): string {
  return raw.normalize('NFC').replace(ZERO_WIDTH_RE, '').trim();
}

export interface RoundFile {
  type: 'FeatureCollection';
  features: ReadonlyArray<RoundFeature>;
}

export type RoundFeature = TargetFeature | SubmissionFeature;

export interface TargetFeature
  extends Feature<Point, { location: string; ended_at: string | null }> {
  id: 'target';
}

export function targetOf(round: RoundFile): TargetFeature {
  return round.features[0] as TargetFeature;
}

export function endedAtOf(round: RoundFile): string | null {
  return targetOf(round).properties.ended_at;
}

export type SubmissionFeature = Feature<
  Point,
  { player: string; distance: number; location?: string }
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

export function eligibleForNextRound(round: RoundFile): ReadonlySet<string> {
  const eliminated = eliminationsForRound(round);
  return new Set(submitters(round).filter((p) => !eliminated.has(p)));
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
  const eligible = eligibleForNextRound(prevRound);
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

export function formatTargetDiscord(
  round: number,
  target: TargetFeature,
): string {
  const [lon, lat] = target.geometry.coordinates;
  const params = new URLSearchParams({
    api: '1',
    query: `${lat},${lon}`,
  });
  const url = `https://www.google.com/maps/search/?${params}`;
  const coords = formatCoords(target.geometry.coordinates);
  return `# Round ${round}, ${target.properties.location}, [${coords}](${url})`;
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
