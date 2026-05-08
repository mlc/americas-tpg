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
| `yarn test` | Run `node --test` over every `src/**/*.test.ts`. |
| `yarn typecheck` | `tsc --noEmit` over `src/`. |
| `yarn lint` | Biome lint. |
| `yarn format` | Biome formatter, write fixes. |
| `yarn check` | Biome combined lint + format check (use this before committing). |
| `yarn node <file>` | Run any TS file under the PnP runtime. |

`yarn start` flags: `--count <N>` (default 1), `--geojson`, `--rng <crypto|math|random.org>` (default `crypto`).
Round CLIs share `--round N` and `--rounds-dir <dir>`; `create-round` also takes `--rng`.

## Conventions

- **Pre-commit hook.** Husky + lint-staged runs `biome check --write` on staged files at commit time, so formatting/import-organize/safe lint fixes happen automatically. The hook activates via `yarn install` (`prepare: husky`). Don't add a separate "format the repo" step before committing — the hook handles it.
- **Commit messages: terse.** One-line conventional-commit subjects (`feat(scope): …`, `fix(scope): …`, `chore(hooks): …`). No multi-paragraph bodies unless the change genuinely needs the explanation. Match the existing log style.
- **Concurrency: not in scope.** The CLIs assume a single operator running commands serially. Race-condition findings (TOCTOU on round creation, concurrent `submit-round` writers losing updates, submit/end interleaving rolling back `ended_at`) are explicitly accepted as out-of-scope — if a user manages to run two commands at the same time, that's on them. Don't add locks, CAS, or `flag: 'wx'` exclusive opens. Don't surface concurrency findings during code review.

## Architecture

### Points sampler (`yarn start`)

Pipeline lives in `src/index.ts` and composes four pieces:

1. **`rng.ts` / `rng-random-org.ts`** — `RandomSource` abstraction with three implementations: `crypto` (Node `randomBytes`, 53-bit float), `math` (`Math.random`), and `random.org` (HTTPS, fetches 200-value chunks with a 15s timeout and buffers them). `next()` is async because `random.org` is.
2. **`sampler.ts`** — `samplePosition(rng)` produces uniform-on-sphere samples by inverse-CDF on `sin(lat)` within a fixed bounding box exported as `SAMPLING_BBOX` (`lat ∈ [-60, 35]`, `lon ∈ [-120, -30]`). This box is rectangular and contains ocean + parts of the eastern Atlantic; non-Americas points are filtered out downstream by the GADM lookup, not by the sampler. `SAMPLING_BBOX` is the single source of truth — re-use it (e.g., `list-countries.ts` does) rather than redeclaring the bounds.
3. **`gadm.ts`** — opens `data/gadm.gpkg` (path overridable via `GADM_PATH` env var; file is gitignored, must be supplied locally) and exposes `lookup(position)` returning `{ kind: 'ocean' } | { kind: 'mainland-us', feature } | { kind: 'accept', feature }`. Mainland US is rejected by design; **Puerto Rico and the USVI come through as their own `GID_0` values (`PRI`, `VIR`) in GADM 4.10** — they are not children of `USA`, so rejecting `gid_0 === 'USA'` accepts them automatically. Don't "fix" that.
4. **`format.ts`** — `formatHuman` (one line per point, `lat°N/S lon°E/W, level1, country`) and `formatGeoJson` (FeatureCollection). `OutputProps` intentionally renames GADM's `GID_0`/`GID_1` to lowercase `gid0`/`gid1`.

`index.ts` loops `samplePosition → gadm.lookup`, discarding `ocean` / `mainland-us` results until it has `count` accepted points, then formats and prints. The GADM handle is closed in a `finally`.

### TPG (round CLIs)

- **`round-domain.ts`** — `RoundFile` / `TargetFeature` / `SubmissionFeature` types, the 25 m tie-buffer elimination logic (`eliminationsForRound`, `eligibleForNextRound`), eligibility rules, and rendering helpers.
- **`round-file.ts`** — atomic read/write/listing of `rounds/NNN.geojson`. `writeRoundAtomic` runs the file through `applySimplestyle` before serializing — every write recomputes marker styling.
- **`coords.ts`** — `decodeCoord(string)` parses one positional coordinate via `geographiclib-dms`. Accepts decimal, NESW, and DMS forms (`40.7128, -74.0060`, `40.7128°N 74.0060°W`, `40:42:46N 74:00:21W`, `40d42'46"N 74d00'21"W`).
- **`simplestyle.ts`** — applies [simplestyle 1.1](https://github.com/mapbox/simplestyle-spec/blob/master/1.1.0/README.md) `marker-symbol` / `marker-color` to every feature on write. Target = star + black; players = circle + gold/silver/bronze for 1st/2nd/3rd, red for last (same tie rule), gray otherwise. Last beats podium.
- **`language.ts`** — three hand-curated lookup tables for the 54 GADM countries reachable by the sampler: `GID0_TO_ISO639_1` (country → main language code), `GID0_TO_LOCAL_NAME` (country → name in its main language; e.g., `BRA → 'Brasil'`, `HTI → 'Ayiti'`), and `ROUND_LABEL` (language code → translation of "Round"; `es → 'Ronda'`, `pt → 'Rodada'`, `fr → 'Manche'`, `nl → 'Ronde'`, `ht → 'Tou'`). Used at create-round time to localize the target country name and the Discord "Round" header.
- **`create-round.ts`** / **`submit-round.ts`** / **`end-round.ts`** — the three CLIs.

### Round file format (load-bearing)

The on-disk format is plain RFC 7946 GeoJSON. **Do not add a top-level `properties` foreign member** — strict GeoJSON validators reject it, and that bug has already cost us once.

- Top level: `{ type: 'FeatureCollection', features: [...] }` only.
- `features[0]` is the target: `id: 'target'`, point geometry, `properties.location` (string), `properties.ended_at` (`null` while open, ISO 8601 string once closed), and an optional `properties.language` (ISO 639-1 string) for countries with a known main language. The target is also stamped with simplestyle marker properties on every write. `applySimplestyle` spreads `...feature.properties`, so unknown / future fields like `language` survive round-trips.
- `features[1..]` are submissions: `properties.player`, `properties.distance` (km from target), optional `properties.location`, and simplestyle marker properties.
- The round number is **derived from the filename only** (`NNN.geojson`); it does not appear inside the file. `validateRoundFile` and the round CLIs source it from `entry.round` (returned by `resolveRound`).

### Coordinate precision (load-bearing)

Sampled targets are rounded to **5 decimal places** (~1.1 m at the equator) by `round5` in `create-round.ts` *before* `gadm.lookup` runs, so the persisted coordinates and the polygon they were classified against agree byte-for-byte. `formatCoords` in `format.ts` uses `.toFixed(5)` for matching display precision. The two numbers must stay coupled — if you change one, change the other. Submitter coordinates are not rounded; only the sampled target is. The Google Maps `query=lat,lon` parameter in `formatTargetDiscord` uses the raw stored numbers, so `-42.5` stays `-42.5` rather than `-42.50000` — that's intentional.

### `--force` ordering invariant

In `validateSubmissionEligibility`, the early-returns are ordered: ended-round check first, then `force` short-circuit, then prior-round eligibility. `--force` is an operator escape hatch that admits ineligible (round-N-1 last-place / DNS) players but cannot reopen a closed round. The `'--force does not override an ended round'` test pins the order — don't reorder.

### Localization (load-bearing)

The three tables in `language.ts` are coupled by domain rules: `GID0_TO_ISO639_1` and `GID0_TO_LOCAL_NAME` must cover the same set of GIDs, and every language used as a value must appear as a key in `ROUND_LABEL`. `language.test.ts` asserts both invariants. **Adding a country means updating both GID-keyed maps; adding a language means also adding to `ROUND_LABEL`** — otherwise the test fails (and silent partial localization would otherwise sneak through). The Haitian Creole label `Tou` was a deliberate pick over `Wonn` / `Manch`; leave it unless told otherwise. Localization applies only to the target — submission locations stay in GADM English.

### GADM lookup performance

`gadm.ts` is hot-path code and has two performance-driven choices that are easy to undo by accident:

- **`fastQueryBoundingBox`** with a tiny epsilon box around the query point, instead of scanning all features. Candidates are then point-in-polygon tested with `@turf/boolean-point-in-polygon`.
- **Lazy geometry parsing with a per-fid cache.** `parseFeatureRowIntoGeoJSON` is the expensive step; we only call it when a feature is a real candidate, and we memoize the parsed result (or `null` for non-polygon rows) keyed by `fid`. Recent commit history calls out a ~53× speedup from this combination — preserve it.

There is a deliberate type cast in `parseFeature` because `dao.fastQueryBoundingBox` returns rows that `dao.getRow` accepts at runtime but not per the declared `@ngageoint/geopackage` types. The runtime contract is load-bearing; the cast through `unknown` is intentional and commented in place.

### `candidateCountries` and the vertex-in-box heuristic

`gadm.ts` exposes a second query path alongside `lookup`: `candidateCountries(box)` enumerates `(GID_0, NAME_0)` pairs for countries with at least one feature polygon vertex inside `box`. Used by `yarn list-countries` to print countries reachable by the sampler. Vertex-in-box correctly drops antimeridian-wrap fringe entries (Fiji, Kiribati) and Antarctic features whose spatial-index bbox merely clips the band — but it's only correct *at the sampling-box scale*. With a small query box, a polygon could fully enclose the box without contributing any vertex inside it; if you reuse `candidateCountries` for tighter regions, switch to a real polygon-vs-box intersection. Cache impact is benign — `candidateCountries` shares the per-fid parse cache with `lookup` and only warms it.

## Data dependency

`data/gadm.gpkg` is the GADM 4.10 geopackage. It is gitignored and must exist locally. The code expects a feature table named `gadm_410` and properties `GID_0`, `NAME_0`, `GID_1`, `NAME_1`.

## Repo layout pointers

- `src/` — all source.
- `tests/` — `*.test.ts` files, one per source module. Tests import production code from `../src/<module>.ts`. Both directories are in `tsconfig.json`'s `include`.
- `docs/plans/` — historical planning docs; read for context, not authoritative.
- `.yarn/sdks/` — committed PnP editor SDKs. Regenerate after upgrading TypeScript with `yarn dlx @yarnpkg/sdks base`.
