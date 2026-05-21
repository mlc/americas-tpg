import { formatCoords } from './format.ts';
import type { LookupLocation } from './gadm.ts';
import type { DnsCheck } from './round-domain.ts';

export interface FormatRoundOutputInput {
  round: number;
  standings: string;
  eliminations: ReadonlySet<string>;
  dnsSet: ReadonlySet<string>;
  nextEligible: ReadonlySet<string>;
  savedSet: ReadonlySet<string>;
  dnsChecks: readonly DnsCheck[];
  lookupLocation: LookupLocation;
}

export function formatRoundOutput(input: FormatRoundOutputInput): string {
  const sections: string[] = [];
  sections.push(`Round ${input.round} results`);
  sections.push('');
  sections.push(input.standings);

  if (input.eliminations.size > 0 || input.dnsSet.size > 0) {
    sections.push('');
    sections.push('Eliminated:');
    if (input.eliminations.size === 1) {
      const [only] = input.eliminations;
      sections.push(`  ${only} (last place)`);
    } else if (input.eliminations.size > 1) {
      const sorted = [...input.eliminations].sort();
      sections.push(`  ${sorted.join(', ')} (tied for last, within 25 m)`);
    }
    if (input.dnsSet.size > 0) {
      const sorted = [...input.dnsSet].sort();
      for (const name of sorted) {
        sections.push(`  ${name} (did not submit)`);
      }
    }
  }

  if (input.savedSet.size > 0) {
    const honest = input.dnsChecks
      .filter((c) => !c.couldHaveEscaped)
      .sort((a, b) => a.player.localeCompare(b.player));
    sections.push('');
    sections.push('Saved by honest-DNS rule:');
    const saved = [...input.savedSet].sort();
    const triggerList =
      honest.length > 0
        ? ` (triggered by ${honest
            .map(
              (c) =>
                `${c.player}'s best historical at ${formatBestDistance(c)}`,
            )
            .join('; ')})`
        : '';
    for (const name of saved) {
      sections.push(`  ${name}${triggerList}`);
    }
  }

  if (input.dnsChecks.length > 0) {
    sections.push('');
    sections.push('DNS could-have-sent:');
    for (const check of input.dnsChecks.toSorted((a, b) =>
      a.player.localeCompare(b.player),
    )) {
      sections.push(
        `  ${check.player}: ${formatDnsCheckDetail(check, input.lookupLocation)}`,
      );
    }
  }

  sections.push('');
  if (input.nextEligible.size === 0) {
    sections.push('Game over: stalemate (no winner).');
  } else if (input.nextEligible.size === 1) {
    const [winner] = input.nextEligible;
    sections.push(`Game over. Winner: ${winner}`);
  } else {
    const sorted = [...input.nextEligible].sort();
    sections.push(`Round ${input.round + 1} starts with: ${sorted.join(', ')}`);
  }

  return sections.join('\n');
}

function formatBestDistance(check: DnsCheck): string {
  if (check.best === null) return 'no submission history available';
  return `${check.best.distanceKm.toFixed(3)} km`;
}

function formatDnsCheckDetail(
  check: DnsCheck,
  lookupLocation: LookupLocation,
): string {
  if (check.best === null) return 'no submission history available';
  const coords = formatCoords(check.best.point);
  const region = lookupLocation(check.best.point);
  const where = region ? `${coords}, ${region}` : coords;
  return `${check.best.distanceKm.toFixed(3)} km from target (${where})`;
}
