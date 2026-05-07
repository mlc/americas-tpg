import type { Feature, Point } from 'geojson';

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
>;

export function isTargetFeature(f: RoundFeature): f is TargetFeature {
  return f.id === 'target';
}

export function targetOf(round: RoundFile): TargetFeature {
  const target = round.features[0];
  if (!target || !isTargetFeature(target)) {
    throw new Error('round file has no target feature at features[0]');
  }
  return target;
}

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
  const [lon, lat] = target.geometry.coordinates;
  const latStr = `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(6)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}, ${target.properties.location}`;
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
