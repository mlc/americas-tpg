import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { create } from 'xmlbuilder2';
import { exitWithError, isMain, isParseArgsError } from './cli-helpers.ts';
import {
  endedAtOf,
  type RoundFeature,
  type RoundFile,
} from './round-domain.ts';
import { DEFAULT_ROUNDS_DIR, listRoundFiles, readRound } from './round-file.ts';
import { SIMPLESTYLE } from './simplestyle.ts';

const KML_NS = 'http://www.opengis.net/kml/2.2';
const DOCUMENT_NAME = 'Américas TPG Rounds';
const DEFAULT_OUTPUT = 'rounds.kml';

// Google's white "paddle" pins (teardrop with a knocked-out symbol). White
// base pixels multiply cleanly under IconStyle <color>, so the pin renders in
// the marker color with the symbol inside — unlike the flat black `shapes/`
// glyphs, which stay black because black * any color = black.
const ICON_BASE = 'http://maps.google.com/mapfiles/kml/paddle';
const STAR_ICON = `${ICON_BASE}/wht-stars.png`;
const CIRCLE_ICON = `${ICON_BASE}/wht-circle.png`;

const HEX6_RE = /^#?([0-9a-fA-F]{6})$/;
// Default-player gray, mirroring SIMPLESTYLE.DEFAULT_PLAYER ('#444444'). Used as
// the rrggbb fallback when a marker-color is missing or malformed.
const FALLBACK_RGB6 = '444444';

/** The lowercase `rrggbb` of a simplestyle hex color, or the default-player
 * color on malformed input. */
function rgb6(hex: string): string {
  const match = HEX6_RE.exec(hex.trim());
  return (match ? match[1] : FALLBACK_RGB6).toLowerCase();
}

/**
 * Convert a simplestyle `#rrggbb` color to a KML `aabbggrr` color string at
 * full, fixed opacity (`aa` is always `ff`). KML's byte order is the reverse
 * of web hex: `#d4af37` → `ff37afd4`. Malformed input falls back to the
 * default-player gray.
 */
export function simplestyleColorToKml(hex: string): string {
  const rgb = rgb6(hex);
  const rr = rgb.slice(0, 2);
  const gg = rgb.slice(2, 4);
  const bb = rgb.slice(4, 6);
  return `ff${bb}${gg}${rr}`;
}

/** Google-hosted white paddle pin for a simplestyle marker symbol: `star` →
 * star paddle, anything else (circle / unknown / missing) → circle paddle.
 * White-based so IconStyle <color> tints the pin to the marker color. */
export function iconHrefForSymbol(symbol: string): string {
  return symbol === SIMPLESTYLE.TARGET_SYMBOL ? STAR_ICON : CIRCLE_ICON;
}

/** Shared-style id for a (symbol, color) pair, e.g. `s_star_000000`. */
function styleIdFor(symbol: string, color: string): string {
  return `s_${symbol}_${rgb6(color)}`;
}

/**
 * The simplestyle markers `applySimplestyle` stamps on every feature. They are
 * not declared in `TargetProperties` / `SubmissionProperties`, so the KML
 * builder reads them through this widened lookup rather than the domain types.
 * Missing values fall back to a gray circle.
 */
function markerOf(feature: RoundFeature): { symbol: string; color: string } {
  const props = feature.properties as Record<string, unknown>;
  const symbol = props['marker-symbol'];
  const color = props['marker-color'];
  return {
    symbol: typeof symbol === 'string' ? symbol : SIMPLESTYLE.PLAYER_SYMBOL,
    color: typeof color === 'string' ? color : SIMPLESTYLE.DEFAULT_PLAYER,
  };
}

/**
 * Pure builder: render rounds as a single KML 2.2 document — one shared
 * `<Style>` per distinct (symbol, color) at `<Document>` level, one `<Folder>`
 * per round (in the order given), one `<Placemark>` per feature named for its
 * `properties.player` (`Target` for the target). Transcribes the on-disk
 * simplestyle markers; it does not recompute eliminations. Throws on empty
 * input; ended/in-progress filtering is the caller's job (see `generateKml`).
 */
export function buildRoundsKml(rounds: readonly RoundFile[]): string {
  if (rounds.length === 0) {
    throw new Error('no rounds to export');
  }

  // Distinct (symbol, color) pairs across every feature → shared styles.
  const styles = new Map<string, { symbol: string; color: string }>();
  for (const round of rounds) {
    for (const feature of round.features) {
      const marker = markerOf(feature);
      styles.set(styleIdFor(marker.symbol, marker.color), marker);
    }
  }

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const document = doc.ele('kml', { xmlns: KML_NS }).ele('Document');
  document.ele('name').txt(DOCUMENT_NAME).up();

  const sortedStyles = [...styles.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [id, { symbol, color }] of sortedStyles) {
    const iconStyle = document.ele('Style', { id }).ele('IconStyle');
    iconStyle.ele('color').txt(simplestyleColorToKml(color)).up();
    iconStyle.ele('Icon').ele('href').txt(iconHrefForSymbol(symbol)).up().up();
    // Paddle pins point from the bottom-center, so anchor the tip on the point.
    iconStyle
      .ele('hotSpot', {
        x: '0.5',
        y: '0',
        xunits: 'fraction',
        yunits: 'fraction',
      })
      .up();
  }

  for (const round of rounds) {
    const folder = document.ele('Folder');
    folder.ele('name').txt(`Round ${round.roundInfo.number}`).up();
    for (const feature of round.features) {
      const marker = markerOf(feature);
      const [lon, lat] = feature.geometry.coordinates;
      const placemark = folder.ele('Placemark');
      placemark.ele('name').txt(feature.properties.player).up();
      placemark
        .ele('styleUrl')
        .txt(`#${styleIdFor(marker.symbol, marker.color)}`)
        .up();
      placemark.ele('Point').ele('coordinates').txt(`${lon},${lat}`).up().up();
    }
  }

  return doc.end({ prettyPrint: true });
}

interface GenerateKmlDeps {
  roundsDir: string;
}

interface GenerateKmlResult {
  kml: string;
  rounds: number;
}

/**
 * Read every ended round in `roundsDir` and build the KML document.
 * In-progress rounds (`endedAt: null`) are skipped, mirroring
 * `generateLeaderboard`. Throws if there are no ended rounds.
 */
export async function generateKml(
  deps: GenerateKmlDeps,
): Promise<GenerateKmlResult> {
  const entries = await listRoundFiles(deps.roundsDir);
  const ended: RoundFile[] = [];
  for (const entry of entries) {
    const file = await readRound(entry.path);
    if (endedAtOf(file) !== null) ended.push(file);
  }
  if (ended.length === 0) {
    throw new Error('no ended rounds found');
  }
  return { kml: buildRoundsKml(ended), rounds: ended.length };
}

const USAGE = `Usage: yarn build-kml [--rounds-dir <dir>] [-o <file>]

Exports every ended round in the rounds directory to a single KML file: one
<Folder> per round, one <Placemark> per point (named for the player, or
"Target"), styled from the simplestyle markers persisted on disk. In-progress
rounds are skipped.

Options:
      --rounds-dir <d>  Rounds directory (default: ${DEFAULT_ROUNDS_DIR})
  -o, --output <f>      Output KML path (default: ${DEFAULT_OUTPUT})
  -h, --help            Show this message
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'rounds-dir': { type: 'string' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const roundsDir = values['rounds-dir'] ?? DEFAULT_ROUNDS_DIR;
  const output = values.output ?? DEFAULT_OUTPUT;
  const { kml, rounds } = await generateKml({ roundsDir });
  await writeFile(output, `${kml}\n`, 'utf8');
  process.stdout.write(
    `wrote ${output} (${rounds} round${rounds === 1 ? '' : 's'})\n`,
  );
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isParseArgsError(cause)) fail(message);
    else exitWithError(message);
  }
}
