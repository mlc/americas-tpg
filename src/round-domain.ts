import type { Feature, Point } from 'geojson';
import { formatCoords } from './format.ts';

export const TIE_BUFFER_KM = 0.025;

export interface RoundFile {
  type: 'FeatureCollection';
  properties: {
    round: number;
    ended_at: string | null;
  };
  features: ReadonlyArray<RoundFeature>;
}

export type RoundFeature = TargetFeature | SubmissionFeature;

export interface TargetFeature extends Feature<Point, { location: string }> {
  id: 'target';
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
  prevRound: RoundFile | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function validateSubmissionEligibility({
  player,
  currentRound,
  prevRound,
}: EligibilityCheck): EligibilityResult {
  if (currentRound.properties.ended_at !== null) {
    return {
      eligible: false,
      reason: `round ${currentRound.properties.round} is ended; submissions are closed`,
    };
  }
  if (prevRound === null) return { eligible: true };
  const eligible = eligibleForNextRound(prevRound);
  if (eligible.has(player)) return { eligible: true };
  const sorted = [...eligible].sort();
  const list = sorted.length === 0 ? '(none)' : sorted.join(', ');
  return {
    eligible: false,
    reason: `player '${player}' not eligible for round ${currentRound.properties.round}. Eligible: ${list}`,
  };
}

export function formatLocation(props: {
  name_0?: string | null;
  name_1?: string | null;
}): string | null {
  if (!props.name_0) return null;
  if (props.name_1) return `${props.name_1}, ${props.name_0}`;
  return props.name_0;
}

export function formatTargetLine(target: TargetFeature): string {
  return `${formatCoords(target.geometry.coordinates)}, ${target.properties.location}`;
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
