import { readFile, writeFile } from 'node:fs/promises';
import { format, parse } from 'node:path';
import { parseArgs } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { create } from 'xmlbuilder2';
import { exitWithError, isMain, isParseArgsError } from './cli-helpers.ts';
import {
  endedAtOf,
  normalizePlayerName,
  type RoundFeature,
  type RoundFile,
  submissionsOf,
  targetOf,
} from './round-domain.ts';
import { DEFAULT_ROUNDS_DIR, listRoundFiles, readRound } from './round-file.ts';
import { SIMPLESTYLE } from './simplestyle.ts';

const KML_NS = 'http://www.opengis.net/kml/2.2';
const DOCUMENT_NAME = 'Américas TPG Rounds';
const DEFAULT_OUTPUT = 'rounds.kmz';

// Google My Maps shows at most 10 layers (one <Folder>/round = one layer) per
// map, so importing a KMZ with more rounds silently drops the overflow. When
// there are more ended rounds than this, the export is split into multiple KMZ
// files of at most this many rounds each.
const MAX_ROUNDS_PER_KMZ = 10;

// Pin PNGs are 64x64 with the teardrop tip at the bottom-centre; anchor the tip
// on the point (insetPixels measures y from the top of the icon).
const ICON_SIZE = 64;
const HOTSPOT = {
  x: String(ICON_SIZE / 2),
  y: String(ICON_SIZE),
  xunits: 'pixels',
  yunits: 'insetPixels',
} as const;

// Color-baked pin images live here (committed; regenerate with
// scripts/render-pins.sh). Google My Maps ignores KML <IconStyle><color> on
// import, so the marker color is baked into each PNG instead of tinted in KML.
const PIN_DIR = new URL('../assets/pins/', import.meta.url);

const HEX6_RE = /^#?([0-9a-fA-F]{6})$/;
const FALLBACK_RGB6 = '444444'; // mirrors SIMPLESTYLE.DEFAULT_PLAYER ('#444444')

/** The lowercase `rrggbb` of a simplestyle hex color, or the default-player
 * color on malformed input. */
function rgb6(hex: string): string {
  const match = HEX6_RE.exec(hex.trim());
  return (match ? match[1] : FALLBACK_RGB6).toLowerCase();
}

/** Style/pin id for a (symbol, color) pair, e.g. `s_star_000000`. Also the
 * basename of the bundled pin PNG (`assets/pins/<id>.png`). */
function styleIdFor(symbol: string, color: string): string {
  return `s_${symbol}_${rgb6(color)}`;
}

// The pin PNGs that exist on disk. A (symbol, color) outside this set — e.g. a
// hand-edited round file with a novel color — clamps to the nearest pin so the
// KMZ never references a missing image: stars fall back to the target pin,
// everything else to the gray default-player pin.
const KNOWN_PIN_IDS: ReadonlySet<string> = new Set([
  styleIdFor(SIMPLESTYLE.TARGET_SYMBOL, SIMPLESTYLE.TARGET_COLOR),
  styleIdFor(SIMPLESTYLE.PLAYER_SYMBOL, SIMPLESTYLE.GOLD),
  styleIdFor(SIMPLESTYLE.PLAYER_SYMBOL, SIMPLESTYLE.SILVER),
  styleIdFor(SIMPLESTYLE.PLAYER_SYMBOL, SIMPLESTYLE.BRONZE),
  styleIdFor(SIMPLESTYLE.PLAYER_SYMBOL, SIMPLESTYLE.LAST),
  styleIdFor(SIMPLESTYLE.PLAYER_SYMBOL, SIMPLESTYLE.DEFAULT_PLAYER),
]);

const TARGET_PIN_ID = styleIdFor(
  SIMPLESTYLE.TARGET_SYMBOL,
  SIMPLESTYLE.TARGET_COLOR,
);
const DEFAULT_PLAYER_PIN_ID = styleIdFor(
  SIMPLESTYLE.PLAYER_SYMBOL,
  SIMPLESTYLE.DEFAULT_PLAYER,
);

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

/** The bundled-pin id a feature renders as, clamped to an id that exists in
 * `assets/pins/`. */
function pinIdOf(feature: RoundFeature): string {
  const { symbol, color } = markerOf(feature);
  const id = styleIdFor(symbol, color);
  if (KNOWN_PIN_IDS.has(id)) return id;
  return symbol === SIMPLESTYLE.TARGET_SYMBOL
    ? TARGET_PIN_ID
    : DEFAULT_PLAYER_PIN_ID;
}

/** The distinct pin ids used across the given rounds, sorted for deterministic
 * output. */
export function collectPinIds(rounds: readonly RoundFile[]): string[] {
  const ids = new Set<string>();
  for (const round of rounds) {
    for (const feature of round.features) ids.add(pinIdOf(feature));
  }
  return [...ids].sort();
}

/**
 * Build the `doc.kml` document for a KMZ: one shared `<Style>` per distinct pin
 * (referencing the bundled `images/<id>.png`), one `<Folder>` per round (in the
 * order given), one `<Placemark>` per feature named for its `properties.player`
 * (`Target` for the target), with the feature's `location` and `distance`
 * carried in `<ExtendedData>` so My Maps shows them on pin click. Pure; throws
 * on empty input. Ended/in-progress filtering is the caller's job (see
 * `generateKmz`).
 */
export function buildRoundsKmlDocument(rounds: readonly RoundFile[]): string {
  if (rounds.length === 0) {
    throw new Error('no rounds to export');
  }

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const document = doc.ele('kml', { xmlns: KML_NS }).ele('Document');
  document.ele('name').txt(DOCUMENT_NAME).up();

  for (const id of collectPinIds(rounds)) {
    const style = document.ele('Style', { id });
    const iconStyle = style.ele('IconStyle');
    iconStyle.ele('scale').txt('1').up();
    iconStyle.ele('Icon').ele('href').txt(`images/${id}.png`).up().up();
    iconStyle.ele('hotSpot', HOTSPOT).up();
    // Hide the persistent label; the player name still shows on click.
    style.ele('LabelStyle').ele('scale').txt('0').up().up();
  }

  for (const round of rounds) {
    const folder = document.ele('Folder');
    folder.ele('name').txt(`Round ${round.roundInfo.number}`).up();
    for (const feature of round.features) {
      const [lon, lat] = feature.geometry.coordinates;
      const placemark = folder.ele('Placemark');
      placemark.ele('name').txt(feature.properties.player).up();
      placemark
        .ele('styleUrl')
        .txt(`#${pinIdOf(feature)}`)
        .up();
      // location/distance shown in My Maps' info window on pin click. The
      // target carries location only (distance is null); submissions carry
      // both (location optional). Emit a <Data> only when the value is present.
      const { location, distance } = feature.properties;
      if (location || distance !== null) {
        const data = placemark.ele('ExtendedData');
        if (location) {
          data.ele('Data', { name: 'location' }).ele('value').txt(location);
        }
        if (distance !== null) {
          data
            .ele('Data', { name: 'distance' })
            .ele('value')
            .txt(`${distance.toFixed(3)} km`);
        }
      }
      placemark.ele('Point').ele('coordinates').txt(`${lon},${lat}`).up().up();
    }
  }

  return doc.end({ prettyPrint: true });
}

/**
 * Build the KMZ archive (a zip of `doc.kml` + the bundled `images/<id>.png`
 * pins) for the given rounds. `loadPin(id)` supplies the PNG bytes for a pin
 * id; `generateKmz` wires it to the committed `assets/pins/` files.
 */
export function buildRoundsKmz(
  rounds: readonly RoundFile[],
  loadPin: (id: string) => Uint8Array,
): Uint8Array {
  const kml = buildRoundsKmlDocument(rounds);
  const files: Record<string, Uint8Array> = { 'doc.kml': strToU8(kml) };
  for (const id of collectPinIds(rounds)) {
    files[`images/${id}.png`] = loadPin(id);
  }
  return zipSync(files);
}

/**
 * Split rounds into consecutive groups of at most `size` (the last group holds
 * the remainder). Pure; preserves input order.
 */
export function chunkRounds(
  rounds: readonly RoundFile[],
  size = MAX_ROUNDS_PER_KMZ,
): RoundFile[][] {
  const chunks: RoundFile[][] = [];
  for (let i = 0; i < rounds.length; i += size) {
    chunks.push(rounds.slice(i, i + size));
  }
  return chunks;
}

/**
 * Output path for one split chunk: the base `output` path with
 * `-<first>-<last>` (3-digit zero-padded round numbers, mirroring `roundPath`)
 * inserted before the extension. Preserves the directory and extension.
 */
export function partOutputPath(
  output: string,
  first: number,
  last: number,
): string {
  const { dir, name, ext } = parse(output);
  const pad = (n: number): string => String(n).padStart(3, '0');
  return format({ dir, name: `${name}-${pad(first)}-${pad(last)}`, ext });
}

/**
 * The output path for each KMZ file `generateKmz` produced, parallel to its
 * `files` array. A single file uses the verbatim `output` path; a split uses
 * `partOutputPath` per chunk so each file is named by its round-number range.
 * Pure.
 */
export function kmzOutputPaths(
  output: string,
  files: readonly { firstRound: number; lastRound: number }[],
): string[] {
  if (files.length === 1) return [output];
  return files.map((f) => partOutputPath(output, f.firstRound, f.lastRound));
}

/**
 * Parse an `--only-players` file: one player per line, blank lines ignored.
 * Names are normalized (NFC + zero-width strip + trim) via `normalizePlayerName`
 * so they compare equal to the normalized player names stored on submissions.
 * Pure.
 */
export function parseOnlyPlayers(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const name = normalizePlayerName(line);
    if (name) names.add(name);
  }
  return names;
}

/**
 * Restrict a round to the listed players: keep the target (always) plus the
 * submissions whose normalized player is in `allowed`, dropping the rest. A
 * round where no listed player submitted becomes target-only. Returns a new
 * RoundFile; `roundInfo` and the target are preserved. Pure.
 */
export function filterRoundToPlayers(
  round: RoundFile,
  allowed: ReadonlySet<string>,
): RoundFile {
  const target = targetOf(round);
  const kept = submissionsOf(round).filter((s) =>
    allowed.has(normalizePlayerName(s.properties.player)),
  );
  return { ...round, features: [target, ...kept] };
}

interface GenerateKmzDeps {
  roundsDir: string;
  /** When set, only these players' submission placemarks are exported; target
   * placemarks are always included. When omitted, every player is exported. */
  onlyPlayers?: ReadonlySet<string>;
}

interface KmzFile {
  kmz: Uint8Array;
  firstRound: number;
  lastRound: number;
  rounds: number;
}

interface GenerateKmzResult {
  files: KmzFile[];
  totalRounds: number;
}

/**
 * Read every ended round in `roundsDir` and build one or more KMZ archives.
 * In-progress rounds (`endedAt: null`) are skipped, mirroring
 * `generateLeaderboard`. More than `MAX_ROUNDS_PER_KMZ` ended rounds split into
 * multiple files (10 rounds each) so each stays under Google My Maps' 10-layer
 * cap. Throws if there are no ended rounds.
 */
export async function generateKmz(
  deps: GenerateKmzDeps,
): Promise<GenerateKmzResult> {
  const entries = await listRoundFiles(deps.roundsDir);
  const ended: RoundFile[] = [];
  for (const entry of entries) {
    const file = await readRound(entry.path);
    if (endedAtOf(file) !== null) ended.push(file);
  }
  if (ended.length === 0) {
    throw new Error('no ended rounds found');
  }

  // Scope each round to the requested players (target always kept) before
  // pins/chunking, so the bundled pins and folder contents reflect the filter.
  const allowed = deps.onlyPlayers;
  const scoped = allowed
    ? ended.map((round) => filterRoundToPlayers(round, allowed))
    : ended;

  const pins = new Map<string, Uint8Array>();
  for (const id of collectPinIds(scoped)) {
    pins.set(id, await readFile(new URL(`${id}.png`, PIN_DIR)));
  }
  const loadPin = (id: string): Uint8Array => {
    const bytes = pins.get(id);
    if (!bytes) throw new Error(`missing pin asset for ${id}`);
    return bytes;
  };

  const files = chunkRounds(scoped).map((chunk) => ({
    kmz: buildRoundsKmz(chunk, loadPin),
    firstRound: chunk[0].roundInfo.number,
    lastRound: chunk[chunk.length - 1].roundInfo.number,
    rounds: chunk.length,
  }));

  return { files, totalRounds: ended.length };
}

const USAGE = `Usage: yarn build-kml [--rounds-dir <dir>] [-o <file>] [--only-players <file>]

Exports every ended round in the rounds directory to KMZ: one <Folder> per
round, one <Placemark> per point (named for the player, or "Target"), each
shown as a Google-Maps-style pin in the simplestyle marker color (a color-baked
PNG bundled in the archive). In-progress rounds are skipped.

Google My Maps shows at most 10 layers per map, so more than 10 rounds split
into files of 10 rounds each, named <output>-NNN-MMM.kmz by round-number range
(e.g. rounds-001-010.kmz). With 10 or fewer rounds the verbatim output path is
used.

With --only-players, only the submission placemarks for the players named in
the given file (one name per line, blank lines ignored) are exported; target
placemarks are always included. Without it, every player is exported.

Options:
      --rounds-dir <d>     Rounds directory (default: ${DEFAULT_ROUNDS_DIR})
  -o, --output <f>         Output KMZ path (default: ${DEFAULT_OUTPUT})
      --only-players <f>   Only export these players (one name per line)
  -h, --help               Show this message
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
      'only-players': { type: 'string' },
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
  const onlyPlayers = values['only-players']
    ? parseOnlyPlayers(await readFile(values['only-players'], 'utf8'))
    : undefined;
  const { files } = await generateKmz({ roundsDir, onlyPlayers });
  const paths = kmzOutputPaths(output, files);
  for (const [i, file] of files.entries()) {
    const path = paths[i];
    await writeFile(path, file.kmz);
    process.stdout.write(
      `wrote ${path} (${file.rounds} round${file.rounds === 1 ? '' : 's'})\n`,
    );
  }
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
