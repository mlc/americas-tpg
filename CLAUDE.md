# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two cooperating tools sharing the same sampler + GADM lookup pipeline:

1. **`yarn start`** — draws uniformly distributed random points within an
   Americas-shaped lat/lon band, resolves each via the GADM 4.10 geopackage to
   `(country, level1)`, rejects ocean / mainland-US hits and resamples.
   Outputs human-readable lines or a GeoJSON `FeatureCollection`.

2. **`yarn create-round` / `submit-round` / `end-round`** — *TPG*, a turn-based
   geo-guessing game. Each round picks a random Americas target, players submit
   coordinates, the farthest (with a 25 m tie buffer) is eliminated, and the
   last surviving player wins. Round state lives on disk in `rounds/NNN.geojson`.

## Documentation files (load-bearing conventions)

The repo has four top-level Markdown files, each with a distinct audience.
Do not collapse them, do not move content between them without being told to,
and in particular:

- **`RULES.md`** — player-facing rules of TPG. **Never edit this file.** It is
  written by humans for humans. If a code change would alter player-visible
  behavior in a way that contradicts `RULES.md`, stop and surface the conflict
  to the user rather than "fixing" the doc.
- **`README.md`** — deliberately short. It is a sign-post pointing at the other
  three docs. Don't grow it back into a full README; previous long-form content
  has been moved to `CODE.md`. New top-level prose for coders/operators goes in
  `CODE.md`, not here.
- **`CODE.md`** — coder and game-operator documentation (what used to live in
  `README.md`). This is the right home for human-readable instructions on
  running the tools, file formats, etc.
- **`CLAUDE.md`** (this file) — guidance for AI coding agents. Architectural
  invariants, non-obvious toolchain quirks, "don't fix that" notes.

## Toolchain (non-obvious bits)

- **Node 24+ with native TypeScript type-stripping.** No build step; `.ts` files run directly. Because of `erasableSyntaxOnly` in `tsconfig.json`, you cannot use `enum`, `namespace`, parameter properties, or other syntax that emits runtime code — stick to `type` / `interface` / `const` objects.
- **Yarn 4 + Plug'n'Play.** There is no `node_modules`. Always run TS files via `yarn node <file>` or the scripts below — bare `node src/foo.ts` will not resolve dependencies.
- **Imports use `.ts` extensions** (e.g. `./gadm.ts`) — that's `allowImportingTsExtensions`, not a typo.
- **Biome** does both lint and format. Single quotes, 2-space indent, LF.
- **Tests** run via Node's built-in test runner: `node --test 'tests/**/*.test.ts'`. No external test framework.

## Commands

| Command | What it does |
| --- | --- |
| `yarn start` | Run `src/index.ts` (the points sampler). |
| `yarn create-round` | Start a new round of TPG. |
| `yarn submit-round <player> <coord>...` | Record a player submission. |
| `yarn end-round` | Close the active round and print standings. |
| `yarn list-countries` | Print every non-USA country whose GADM bbox intersects the sampling band. |
| `yarn test` | Run `node --test` over every `tests/**/*.test.ts`. |
| `yarn typecheck` | `tsc --noEmit` over `src/`. |
| `yarn lint` | Biome lint. |
| `yarn format` | Biome formatter, write fixes. |
| `yarn check` | Biome combined lint + format check (use this before committing). |
| `yarn node <file>` | Run any TS file under the PnP runtime. |

`yarn start` flags: `--count <N>` (default 1), `--geojson`, `--rng <crypto|math|random.org>` (default `crypto`).
Round CLIs share `--round N` and `--rounds-dir <dir>`; `create-round` also takes `--rng`, **defaulting to `random.org`** (not `crypto`) — RULES.md promises players that random.org is the source of truth for round picks, so this default is load-bearing. `yarn start` keeps the `crypto` default because the points sampler is a developer/operator utility, not the player-facing round generator. The shared `parseRng` helper takes a per-call default so the two CLIs can diverge cleanly.

## Conventions

- **Pre-commit hook.** Husky + lint-staged runs `biome check --write` on staged files at commit time, so formatting/import-organize/safe lint fixes happen automatically. The hook activates via `yarn install` (`prepare: husky`). Don't add a separate "format the repo" step before committing — the hook handles it.
- **Commit messages: terse.** One-line conventional-commit subjects (`feat(scope): …`, `fix(scope): …`, `chore(hooks): …`). No multi-paragraph bodies unless the change genuinely needs the explanation. Match the existing log style.
- **Concurrency: not in scope.** The CLIs assume a single operator running commands serially. Race-condition findings (TOCTOU on round creation, concurrent `submit-round` writers losing updates, submit/end interleaving rolling back `ended_at`) are explicitly accepted as out-of-scope — if a user manages to run two commands at the same time, that's on them. Don't add locks, CAS, or `flag: 'wx'` exclusive opens. Don't surface concurrency findings during code review.

## Architecture

### Points sampler (`yarn start`)

Pipeline lives in `src/index.ts` and composes four pieces:

1. **`rng.ts` / `rng-random-org.ts`** — `RandomSource` abstraction with three implementations: `crypto` (Node `randomBytes`, 53-bit float), `math` (`Math.random`), and `random.org` (HTTPS, fetches 200-value chunks with a 15s timeout and buffers them). `next()` is async because `random.org` is.
2. **`sampler.ts`** — `samplePosition(rng)` produces uniform-on-sphere samples by inverse-CDF on `sin(lat)` within a fixed bounding box exported as `SAMPLING_BBOX` (`lat ∈ [-60, 35]`, `lon ∈ [-120, -30]`). This box is rectangular and contains ocean + parts of the eastern Atlantic; non-Americas points are filtered out downstream by the GADM lookup, not by the sampler. `SAMPLING_BBOX` is the single source of truth — re-use it (e.g., `list-countries.ts` does) rather than redeclaring the bounds. The southern boundary is conceptually the Antarctic Convergence (the polar front that runs north of South Georgia), but the bbox itself stays at -60° for sampling simplicity — South Georgia/SSI (`SGS`) is rejected via the GADM lookup's `REJECTED_GIDS` set, not by the bbox.
3. **`gadm.ts`** — opens `data/gadm.gpkg` (path overridable via `GADM_PATH` env var; file is gitignored, must be supplied locally) and exposes `lookup(position)` returning `{ kind: 'ocean' } | { kind: 'rejected', feature } | { kind: 'accept', feature }`. Mainland US and South Georgia are rejected by design via the exported `REJECTED_GIDS = {'USA', 'SGS'}` set; **Puerto Rico and the USVI come through as their own `GID_0` values (`PRI`, `VIR`) in GADM 4.10** — they are not children of `USA`, so rejecting only `USA` accepts them automatically. Don't "fix" that.
4. **`format.ts`** — `formatHuman` (one line per point, `lat°N/S lon°E/W, level1, country`) and `formatGeoJson` (FeatureCollection). `OutputProps` intentionally renames GADM's `GID_0`/`GID_1` to lowercase `gid0`/`gid1`.

`index.ts` loops `samplePosition → gadm.lookup`, discarding `ocean` / `rejected` results until it has `count` accepted points, then formats and prints. The GADM handle is closed in a `finally`.

### TPG (round CLIs)

- **`round-domain.ts`** — `RoundFile` / `TargetFeature` / `SubmissionFeature` types, the 25 m tie-buffer elimination logic (`eliminationsForRound`), eligibility rules, and rendering helpers.
- **`round-file.ts`** — atomic read/write/listing of `rounds/NNN.geojson`. `writeRoundAtomic` runs the file through `applySimplestyle` before serializing — every write recomputes marker styling.
- **`coords.ts`** — `decodeCoord(string)` parses one positional coordinate via `geographiclib-dms`. Accepts decimal, NESW, and DMS forms (`40.7128, -74.0060`, `40.7128°N 74.0060°W`, `40:42:46N 74:00:21W`, `40d42'46"N 74d00'21"W`).
- **`simplestyle.ts`** — applies [simplestyle 1.1](https://github.com/mapbox/simplestyle-spec/blob/master/1.1.0/README.md) `marker-symbol` / `marker-color` to every feature on write. Target = star + black; players = circle + gold/silver/bronze for 1st/2nd/3rd, red for last (same tie rule), gray otherwise. Last beats podium.
- **`language.ts`** — five hand-curated lookup tables for the 53 GADM countries reachable by the sampler: `GID0_TO_ISO639_1` (country → main language code), `GID0_TO_LOCAL_NAME` (country → name in its main language; e.g., `BRA → 'Brasil'`, `HTI → 'Ayiti'`), `ROUND_LABEL` (language code → translation of "Round"; `es → 'Ronda'`, `pt → 'Rodada'`, `fr → 'Manche'`, `nl → 'Ronde'`, `ht → 'Tou'`), `RULES_LABEL` (language code → translation of "Rules"; `es → 'Reglas'`, `pt → 'Regras'`, `fr → 'Règles'`, `nl → 'Regels'`, `ht → 'Règ'`), and `SUBMISSION_TRACKER_LABEL` (language code → translation of "Submission Tracker"; `es → 'Rastreador de Envíos'`, `pt → 'Rastreador de Envios'`, `fr → 'Suivi des Soumissions'`, `nl → 'Inzendingen-tracker'`, `ht → 'Swivi Soumisyon'`). Used at create-round time to localize the target country name, the Discord "Round" header, and the bilingual link text on the tracker and rules link lines.
- **`create-round.ts`** / **`submit-round.ts`** / **`end-round.ts`** — the three CLIs.

### Round file format (load-bearing)

The on-disk format is plain RFC 7946 GeoJSON plus one deliberate top-level
foreign member, `roundInfo` (RFC 7946 §6.1 — foreign members MAY be used).
**Do not add a top-level `properties` foreign member** — strict GeoJSON
validators reject the specific name `properties` at the FeatureCollection
level, and that bug has already cost us once. `roundInfo` is fine because
validators don't special-case it.

- Top level: `{ type: 'FeatureCollection', roundInfo, features: [...] }`.
- `roundInfo` is an object with:
  - `number` — positive integer round number. Also derivable from the
    filename (`NNN.geojson`); `validateRoundFile` requires the two agree
    and fails the read on mismatch.
  - `endedAt` — `null` while the round is open, ISO 8601 string once
    closed. Note the camelCase: this used to live on the target as
    `ended_at`, and the rename is intentional.
  - `language` — optional ISO 639-1 string for countries with a known main
    language. Drives the "Round"/"Ronda"/"Rodada"/etc. translation in
    `formatTargetDiscord` via `roundLabel` from `language.ts`.
- `features[0]` is the target: `id: 'target'`, point geometry, and
  `properties.location` (non-empty string) — *that's it for stable
  fields*. Simplestyle marker properties are stamped on every write by
  `applySimplestyle` and appear alongside `location`. There is no
  per-target `ended_at` or `language` anymore — both moved to `roundInfo`.
  `applySimplestyle` spreads both `...round` (preserving `roundInfo` and
  any other top-level foreign members) and `...feature.properties` on the
  way through, so unknown / future fields survive round-trips at both
  levels.
- `features[1..]` are submissions: `properties.player`,
  `properties.distance` (km from target), optional `properties.location`,
  `properties.eliminated` (boolean — see invariant below), and simplestyle
  marker properties.

### `eliminated` flag invariant (load-bearing)

Submission features carry `properties.eliminated: boolean` **iff** the
round is ended. `validateRoundFile` rejects in-progress rounds whose
submissions carry the field, and rejects ended rounds whose submissions
are missing it (or whose value is non-boolean). `endRound` stamps the
flag on every submission at the moment of closing, derived from
`eliminationsForRound` against the same distances visible on disk.
`validateSubmissionEligibility` and `endRound`'s DNS computation both
**read the persisted flag** from the previous round instead of
recomputing eliminations from distances, and both throw if handed an
in-progress prev round (the precondition is guarded explicitly because
the file validator alone considers an in-progress round well-formed).
The function `eligibleForNextRound` was removed when this flag was
introduced; there is no longer a recompute path on the consumer side.

### Honest-DNS save rule (load-bearing)

`endRound` runs an anti-griefing rule on top of standard elimination:
when a did-not-submit player could not realistically have escaped
elimination — judged from their submission history in this game's prior
rounds plus the MorphiorDB API at `https://tpg.marsmathis.com/api` — the
actual last-place submitter(s) are spared instead. The rule's per-DNS
findings persist as `roundInfo.dnsChecks` (an array of `DnsCheck` items
defined in `round-domain.ts`):

- Each item carries `player`, `couldHaveEscaped` (boolean), `best`
  (`{ point: [lon, lat]; distanceKm: number } | null` — bundled so the
  type system enforces "both populated or both null"),
  `morphiorDbStatus` (`ok | noMatch | unavailable`), and
  `morphiorDbSubmissionCount` (non-negative integer when status is `ok`,
  null otherwise — reflects the count of submission rows the parser kept
  with finite lat/lon, not the raw API row count, so a malformed-row drop
  is invisible at this level).
- `noMatch` covers both "zero exact matches" and "ambiguous (multiple
  exact matches)" — both fall back to local-only history, so the rule
  sees them identically; the audit trail records them under one label.
- The escape predicate is `bestDistanceKm < currentMaxKm − TIE_BUFFER_KM`
  — strict `<`, mirroring `eliminationsForRound`'s tie-buffer math so the
  boundary aligns exactly.
- Anti-ghost: a player with zero historical submissions across both
  sources is treated as `couldHaveEscaped: true` and never triggers a
  save (prevents new accounts from gaming the rule by ducking rounds
  before establishing history).
- Save logic is binary across multiple DNS: any single honest-DNS player
  triggers saving the actual last-place submitter(s); multiple honest-DNS
  do not compound — only one save event per round.
- MorphiorDB unavailability degrades gracefully to local-only history;
  the per-DNS check records `morphiorDbStatus: 'unavailable'` and the
  round closes normally.

`validateRoundFile` enforces presence-iff-ended on `roundInfo.dnsChecks`:
in-progress rounds (`endedAt: null`) MUST NOT carry the field; ended
rounds MUST carry it as an array (possibly empty). `endRound`'s re-end
branch reads `roundInfo.dnsChecks` from disk and computes the saved-set
as `eliminationsForRound(current)` minus `eliminationsFromFlags(current)`
without re-querying MorphiorDB — re-end is deterministic and produces
identical output text.

### Coordinate precision (load-bearing)

Sampled targets are rounded to **5 decimal places** (~1.1 m at the equator) by `round5` in `create-round.ts` *before* `gadm.lookup` runs, so the persisted coordinates and the polygon they were classified against agree byte-for-byte. `formatCoords` in `format.ts` uses `.toFixed(5)` for matching display precision. The two numbers must stay coupled — if you change one, change the other. Submitter coordinates are not rounded; only the sampled target is. The Google Maps `query=lat,lon` parameter in `formatTargetDiscord` uses the raw stored numbers, so `-42.5` stays `-42.5` rather than `-42.50000` — that's intentional.

### `--force` ordering invariant

In `validateSubmissionEligibility`, the early-returns are ordered: ended-round check first, then `force` short-circuit, then prior-round eligibility. `--force` is an operator escape hatch that admits ineligible (round-N-1 last-place / DNS) players but cannot reopen a closed round. The `'--force does not override an ended round'` test pins the order — don't reorder.

### Localization (load-bearing)

The five tables in `language.ts` are coupled by domain rules: `GID0_TO_ISO639_1` and `GID0_TO_LOCAL_NAME` must cover the same set of GIDs, and every language used as a value must appear as a key in **all of** `ROUND_LABEL`, `RULES_LABEL`, **and** `SUBMISSION_TRACKER_LABEL`. `language.test.ts` asserts all four invariants. **Adding a country means updating both GID-keyed maps; adding a language means also adding to `ROUND_LABEL`, `RULES_LABEL`, and `SUBMISSION_TRACKER_LABEL`** — otherwise the test fails (and silent partial localization would otherwise sneak through). The Haitian Creole label `Tou` was a deliberate pick over `Wonn` / `Manch`; leave it unless told otherwise. Localization applies only to the target — submission locations stay in GADM English. The selected language is persisted as `roundInfo.language` on the round file (not on the target's properties), and `formatTargetDiscord` reads it from there.

`formatTargetDiscord` produces a three-line message: a `# {Round-word} N, location, [coords](google-maps-url)` header, then `[Submission Tracker / {translated}](tracker-url)`, then `[Rules / {translated}](RULES_URL)` — each on its own line, in that exact order. Both link texts are **bilingual** for non-English rounds (English first, then translation, separated by ` / `) and plain English for English / unknown / missing language. `RULES_URL` (in `round-domain.ts`) points at `https://github.com/mlc/americas-tpg/blob/main/RULES.md` — the public-facing rules document; don't repoint it at a local path or fork URL. The submission-tracker URL is built by `submissionTrackerUrl(round)` (also in `round-domain.ts`) as `https://geojson.io/#id=github:mlc/americas-tpg/blob/main/rounds/NNN.geojson`, where `NNN` is the round number zero-padded to 3 digits — mirroring the `rounds/NNN.geojson` filename convention from `roundPath`. The result is consumed via `CreateRoundResult.targetLine` (name kept for compatibility — it's multi-line) and printed by the create-round CLI.

### GADM lookup performance

`gadm.ts` is hot-path code and has two performance-driven choices that are easy to undo by accident:

- **`fastQueryBoundingBox`** with a tiny epsilon box around the query point, instead of scanning all features. Candidates are then point-in-polygon tested with `@turf/boolean-point-in-polygon`.
- **Lazy geometry parsing with a per-fid cache.** `parseFeatureRowIntoGeoJSON` is the expensive step; we only call it when a feature is a real candidate, and we memoize the parsed result (or `null` for non-polygon rows) keyed by `fid`. Recent commit history calls out a ~53× speedup from this combination — preserve it.

There is a deliberate type cast in `parseFeature` because `dao.fastQueryBoundingBox` returns rows that `dao.getRow` accepts at runtime but not per the declared `@ngageoint/geopackage` types. The runtime contract is load-bearing; the cast through `unknown` is intentional and commented in place.

### `candidateCountries` and the vertex-in-box heuristic

`gadm.ts` exposes a second query path alongside `lookup`: `candidateCountries(box)` enumerates `(GID_0, NAME_0)` pairs for countries with at least one feature polygon vertex inside `box`. Used by `yarn list-countries` to print countries reachable by the sampler. Vertex-in-box correctly drops antimeridian-wrap fringe entries (Fiji, Kiribati) and Antarctic features whose spatial-index bbox merely clips the band — but it's only correct *at the sampling-box scale*. With a small query box, a polygon could fully enclose the box without contributing any vertex inside it; if you reuse `candidateCountries` for tighter regions, switch to a real polygon-vs-box intersection. Cache impact is benign — `candidateCountries` shares the per-fid parse cache with `lookup` and only warms it. Note that `candidateCountries` is **not** the rejection point: countries in `REJECTED_GIDS` (currently `USA` and `SGS`) still appear in its output and are filtered downstream in `list-countries.ts`.

## Data dependency

`data/gadm.gpkg` is the GADM 4.10 geopackage. It is gitignored and must exist locally. The code expects a feature table named `gadm_410` and properties `GID_0`, `NAME_0`, `GID_1`, `NAME_1`.

## Repo layout pointers

- `src/` — all source.
- `tests/` — `*.test.ts` files, one per source module. Tests import production code from `../src/<module>.ts`. Both directories are in `tsconfig.json`'s `include`.
- `docs/plans/` — historical planning docs; read for context, not authoritative.
- `.yarn/sdks/` — committed PnP editor SDKs. Regenerate after upgrading TypeScript with `yarn dlx @yarnpkg/sdks base`.
