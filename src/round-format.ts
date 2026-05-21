import { Instant, LocalTime, ZoneId } from '@js-joda/core';
import type { Feature, Point } from 'geojson';
import { formatCoords } from './format.ts';
import {
  leaderboardLinkText,
  mainCountryName,
  roundLabel,
  rulesLinkText,
  submissionTrackerLinkText,
} from './language.ts';
import {
  type DnsCheck,
  type RoundFile,
  submissionsOf,
  targetOf,
} from './round-domain.ts';

export const RULES_URL =
  'https://github.com/mlc/americas-tpg/blob/main/RULES.md';

export const LEADERBOARD_URL =
  'https://github.com/mlc/americas-tpg/blob/main/LEADERBOARD.md';

/**
 * Public URL to the round's GeoJSON viewed in geojson.io. Mirrors the
 * filename convention from `roundPath`: `rounds/NNN.geojson` with `NNN`
 * zero-padded to 3 digits.
 */
export function submissionTrackerUrl(round: number): string {
  const padded = String(round).padStart(3, '0');
  return `https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/${padded}.geojson`;
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

export function googleMapsUrl(feature: Feature<Point>): string {
  const [lon, lat] = feature.geometry.coordinates;
  const params = new URLSearchParams({
    api: '1',
    query: `${lat},${lon}`,
  });
  return `https://www.google.com/maps/search/?${params}`;
}

export const roundExpiry = (now = Instant.now(), daysAhead = 1): Instant =>
  now
    .atZone(ZoneId.of('America/New_York'))
    .plusDays(daysAhead)
    .with(LocalTime.parse('21:00'))
    .toInstant();

export function formatTargetDiscord(file: RoundFile, now?: Instant): string {
  const target = targetOf(file);
  const url = googleMapsUrl(target);
  const coords = formatCoords(target.geometry.coordinates);
  const word = roundLabel(file.roundInfo.language);
  const header = `# ${word} ${file.roundInfo.number}, ${target.properties.location}, [${coords}](${url})`;
  const trackerLink = `[${submissionTrackerLinkText(file.roundInfo.language)}](<${submissionTrackerUrl(file.roundInfo.number)}>)`;
  const rulesLink = `[${rulesLinkText(file.roundInfo.language)}](${RULES_URL})`;
  const leaderboardLink = `[${leaderboardLinkText(file.roundInfo.language)}](<${LEADERBOARD_URL}>)`;
  const expiry = roundExpiry(now);
  const expiryString = `Submissions close <t:${expiry.epochSecond()}:R>`;
  const [lon, lat] = target.geometry.coordinates;
  const plainCoords = `Coordinates for degree-sign haters: \`${lat},${lon}\``;
  return [
    header,
    trackerLink,
    rulesLink,
    leaderboardLink,
    expiryString,
    plainCoords,
  ].join('\n');
}

interface RoundResultDiscordInput {
  round: RoundFile;
  /** Submitters eliminated this round (post-honest-DNS-rule). DNS players
   * are not included here; they go in `dnsSet`. */
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
  /** Submitters spared by the honest-DNS save rule. Empty when the rule
   * didn't fire. */
  savedSet: ReadonlySet<string>;
  /** Per-DNS-player rule evaluations; used to name the player(s) whose
   * history triggered the save. */
  dnsChecks: readonly DnsCheck[];
}

export const formatPlayersList = (players: readonly string[]): string => {
  switch (players.length) {
    case 0:
      // shouldn't happen
      return '';
    case 1:
      return `@${players[0]}`;
    case 2:
      return `@${players[0]} and @${players[1]}`;
    default:
      return `${players
        .slice(0, -1)
        .map((p) => `@${p}`)
        .join(', ')}, and @${players.at(-1)}`;
  }
};

export function formatRoundResultDiscord(
  input: RoundResultDiscordInput,
): string {
  const lines: string[] = [`## Round ${input.round.roundInfo.number} complete`];
  const eliminatedSubmissions = submissionsOf(input.round)
    .filter((s) => input.eliminations.has(s.properties.player))
    .toSorted((a, b) => a.properties.distance - b.properties.distance);
  if (eliminatedSubmissions.length === 1) {
    const [sub] = eliminatedSubmissions;
    lines.push(
      `Unfortunately, @${sub.properties.player}, at ${sub.properties.distance.toFixed(3)}km away, has been eliminated.`,
    );
  } else if (eliminatedSubmissions.length > 1) {
    const mentions = formatPlayersList(
      eliminatedSubmissions.map((submission) => submission.properties.player),
    );
    const km = eliminatedSubmissions[0].properties.distance;
    lines.push(
      `Unfortunately, ${mentions}, tied for last within 25m at ${km.toFixed(3)}km away, have been eliminated.`,
    );
  }
  if (input.dnsSet.size > 0) {
    lines.push(
      `Unfortunately, ${formatPlayersList([...input.dnsSet].toSorted())} did not submit and ${input.dnsSet.size > 1 ? 'have' : 'has'} been eliminated.`,
    );
  }
  if (input.savedSet.size > 0) {
    const honest = input.dnsChecks
      .filter((c) => !c.couldHaveEscaped)
      .toSorted((a, b) => a.player.localeCompare(b.player));
    for (const player of [...input.savedSet].sort()) {
      lines.push(
        `${player} was saved because ${formatPlayersList(honest.map(({ player }) => player))}'s best known submission would not have been safe from elimination.`,
      );
    }
  }
  if (input.nextEligible.size === 0) {
    lines.push('Game over: stalemate, no winner.');
  } else if (input.nextEligible.size === 1) {
    const [winner] = input.nextEligible;
    lines.push(`Game over! @${winner} wins!`);
  } else {
    lines.push(`${input.nextEligible.size} players remain.`);
  }
  return lines.join('\n');
}

export function formatStandings(round: RoundFile): string {
  const subs = submissionsOf(round);
  if (subs.length === 0) {
    return 'Standings:\n  (no submissions)';
  }
  const sorted = subs.toSorted(
    (a, b) => a.properties.distance - b.properties.distance,
  );
  const lines = sorted.map((s, i) => {
    const rank = String(i + 1).padStart(2);
    const distance = `${s.properties.distance.toFixed(3)} km`;
    return `  ${rank}. ${s.properties.player}  ${distance}`;
  });
  return ['Standings:', ...lines].join('\n');
}
