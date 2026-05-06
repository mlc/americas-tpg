---
title: 'feat: Random Americas geocoder CLI'
type: feat
status: completed
date: 2026-05-06
---

# feat: Random Americas geocoder CLI

## Summary

A CLI that generates one or more random points inside the Americas (35°N–60°S, 120°W–30°W), rejecting non-land samples and mainland-US samples by looking each candidate up in a local GADM geopackage via `@ngageoint/geopackage`. Data flows through GeoJSON-typed values internally and is converted to either human-readable text or a GeoJSON `FeatureCollection` at the output boundary. Randomness is supplied by a pluggable backend (default `crypto`, also `math` and `random.org`).

---

## Problem Frame

We want a small CLI that produces "drop a pin somewhere in the Americas south of the United States" — a uniformly-distributed (on the sphere) random land coordinate, annotated with its country and first-level subdivision. The repo is brand-new with the baseline TS/Yarn-PnP/Biome tooling already in place; this is the project's first real feature.

---

## Requirements

- R1. Sample latitudes from 35°N to 60°S using the inverse-transform formula `lat_rad = (π/2) - acos(y)` with `y` uniform in `[-1, 1]`, rejecting and resampling values outside the range so the accepted distribution is uniform on the sphere's surface area within the band.
- R2. Sample longitudes uniformly from 120°W to 30°W.
- R3. Open the GADM geopackage via `@ngageoint/geopackage` and look up the first-level administrative subdivision containing each candidate point.
- R4. Reject candidates that are not on land.
- R5. Reject candidates whose containing feature has GADM country code `USA`, **except** when the first-level subdivision name is Puerto Rico or the U.S. Virgin Islands.
- R6. Loop sampling until the requested number of acceptable points has been produced.
- R7. Carry sampled points and looked-up admin features as GeoJSON-typed values internally (`Position`, `Point`, `Feature`), using `@types/geojson`.
- R8. Print results as human-readable lines by default, or as a single GeoJSON `FeatureCollection` when `--geojson` is passed.
- R9. Support `--count <N>` / `-n <N>` to request `N` points (default 1) within a single invocation.
- R10. Support `--rng <crypto|math|random.org>` to select the randomness source (default `crypto`); all three implementations live behind a single async interface.
- R11. The geopackage file location is configurable via the `GADM_PATH` environment variable, defaulting to `data/gadm.gpkg`. Missing-file failures produce a clear error message naming the env var.

---

## Scope Boundaries

- Web UI, REST API, daemon mode.
- Distance-from-coast, elevation, climate, or other secondary filters.
- Cross-invocation caching of GADM features; the package is opened once per invocation only.
- A test runner or test infrastructure (the project's plan-of-record defers this).
- Other regions outside the stated bounding box.
- Signed responses from random.org; the API-key-authenticated random.org JSON-RPC API.
- Distributing or committing the GADM geopackage; users supply their own copy.

---

## Context & Research

### Relevant Code and Patterns

- `src/index.ts` — currently a one-line placeholder (`console.log('americas: ready');`). This plan replaces it with the CLI entry.
- `tsconfig.json` — already configured for native Node 24 type-stripping with `erasableSyntaxOnly: true`. New TypeScript source must avoid enums, namespaces, and parameter-property class shorthand (anything `node` can't strip).
- `package.json` — already declares `"type": "module"` and `engines.node >=24`. New imports must use ESM syntax.
- `biome.json` — single-quoted strings, 2-space indent, LF; new files must conform.

### External References

- `@ngageoint/geopackage` (npm) — Node.js OGC GeoPackage client. Provides `GeoPackageAPI.open(path)`, feature DAOs per layer, spatial-index-backed bbox queries, and GeoJSON feature iteration. Exact method names are deferred to implementation.
- `@types/geojson` (npm) — canonical TypeScript definitions for the GeoJSON spec (`Position`, `Point`, `Polygon`, `MultiPolygon`, `Feature`, `FeatureCollection`).
- GADM 4.x level-1 subdivisions carry, at minimum, `GID_0`, `NAME_0`, `GID_1`, `NAME_1` columns. Exact column names per the user's GADM build are confirmed at implementation time by inspecting the geopackage's schema.
- random.org plaintext "Decimal Fractions" HTTP endpoint (no API key, free-tier quota): `https://www.random.org/decimal-fractions/?num=N&dec=20&col=1&format=plain&rnd=new`. Returns one decimal per line.

---

## Key Technical Decisions

- **Async RNG interface returning `Promise<number>` in `[0, 1)`**: the only shape that accommodates the network-bound random.org backend; the synchronous backends resolve immediately. A single uniform interface keeps sampler code RNG-agnostic.
- **`crypto` backend uses 53 random bits** (`crypto.randomBytes(7)` masked to 53 bits, divided by `2^53`) rather than `crypto.randomInt()` scaled, because `randomInt` caps at a 48-bit max and would cost ~5 bits of float precision. The bits-and-divide pattern produces full IEEE-754 double precision and is the canonical "crypto float" approach.
- **random.org backend buffers its own pre-fetched values** (default chunk 200) and refills the buffer on empty. This keeps sampler code unaware of the network round-trip and avoids one HTTP request per random number, which would exhaust the free-tier quota immediately in batch mode.
- **Latitude rejection sampling stays within the RNG interface, not as a separate module**: `nextLatitude()` is a small helper that calls the RNG up to a few times until `y` produces a latitude in band. Inverse transform with rejection (rather than bounding `y` to `[sin(-60°), sin(35°)]`) follows the user's stated formula verbatim.
- **Single GADM query per candidate point** against the level-1 layer; country comes from the same feature's `GID_0` / `NAME_0`. No separate level-0 query.
- **Mainland-US filter is an allow-list of `NAME_1` values** (`Puerto Rico`, `United States Virgin Islands`) consulted only when `GID_0 === 'USA'`. All other GADM `USA` features are rejected. This keeps the rule explicit and easy to audit.
- **Geopackage opened once per invocation and reused across the N samples** in batch mode. No long-lived process; the package is closed at the end of `main`.
- **GeoJSON-first internal data model**: every layer between RNG and output produces or consumes `geojson` types. Human-readable formatting is confined to a single formatter that runs once at the boundary, after the loop completes.

---

## Open Questions

### Resolved During Planning

- **How is "uniform on the sphere" achieved?** — by the user-specified inverse-transform formula `lat_rad = (π/2) - acos(y)`, with rejection of out-of-band samples.
- **How are PR and USVI distinguished from mainland US?** — both appear as separate `NAME_1` rows under `GID_0 = 'USA'` in GADM, so they are accepted by an explicit `NAME_1` allow-list.
- **Sync vs async RNG interface?** — async, because random.org is HTTP. Sync backends resolve immediately.
- **Default RNG?** — `crypto`.
- **Where does the GADM file live?** — `data/gadm.gpkg` by convention; overridable with `GADM_PATH`. Not committed.
- **Default count and format?** — count `1`, human-readable.

### Deferred to Implementation

- **Exact GADM level-1 layer name and column names** — confirmed at implementation time by inspecting the user's geopackage schema. The plan assumes GADM 4.x conventions (`GID_0`, `NAME_0`, `GID_1`, `NAME_1`).
- **Exact `@ngageoint/geopackage` method choice for point-in-polygon** — the package exposes bbox-prefixed iterators and per-feature geometry; the implementer picks the cleanest path during U4.
- **random.org error/quota response shape** — discovered when integration is wired up; failure terminates the run with a clear message.
- **Buffer chunk size for random.org** — `200` is a reasonable default; tunable in code, not exposed as a CLI flag.

---

## Implementation Units

- U1. **RNG interface plus `crypto` and `math` backends**

**Goal:** Define the async `RandomSource` interface and ship the two synchronous backends behind it.

**Requirements:** R10

**Dependencies:** None

**Files:**
- Create: `src/rng.ts`

**Approach:**
- Export a `RandomSource` interface with a single method shape: `next(): Promise<number>` returning a uniform float in `[0, 1)`.
- Implement `cryptoRandom`: read 7 random bytes via `node:crypto`, mask to 53 bits, divide by `2^53`. Return as a resolved promise.
- Implement `mathRandom`: wrap `Math.random()` in a resolved promise.
- Export a small registry mapping the RNG name (`'crypto' | 'math' | 'random.org'`) to a factory; `random.org` slot is filled in U2.

**Patterns to follow:**
- `node:crypto` is a built-in module; import via `import { randomBytes } from 'node:crypto'`. Match the project's single-quote and ESM conventions.

**Test scenarios:**
- Test expectation: none — the project plan-of-record defers a test runner. Correctness is reviewed by reading and by sanity-checking outputs in batch mode.

**Verification:**
- `RandomSource` is the single import sampler code uses to get randomness; neither `Math.random` nor `crypto` is referenced anywhere else.
- `cryptoRandom` produces values strictly less than `1.0` and never `NaN` across a quick console-driven smoke run.

---

- U2. **`random.org` RNG backend**

**Goal:** Implement the network-backed RNG with a refillable in-memory buffer.

**Requirements:** R10

**Dependencies:** U1

**Files:**
- Create: `src/rng-random-org.ts`
- Modify: `src/rng.ts` (register the backend in the factory map)

**Approach:**
- The backend keeps a private FIFO buffer of pre-fetched decimals.
- `next()` returns the head of the buffer; on empty, performs a single HTTP request to the random.org plaintext "Decimal Fractions" endpoint with `num=200&dec=20&col=1&format=plain&rnd=new`, parses the response into 200 floats, and refills.
- Use `fetch` (built into Node 24) for the HTTP call; no extra dependency.
- Network failures, non-200 responses, or empty parses surface as a thrown error that propagates out of `next()` and terminates the run with a clear message.

**Patterns to follow:**
- The async interface defined in U1.
- Project ESM and single-quote conventions.

**Test scenarios:**
- Test expectation: none — same rationale as U1; manual smoke via `--rng random.org --count 1` is the verification.

**Verification:**
- A single `--rng random.org` invocation produces a result and prints it.
- The buffer is observed (in code review) to refill at most once per ~100 sampled points in a small batch run, not once per number.

---

- U3. **Coordinate sampler**

**Goal:** Produce a single GeoJSON `Position` (`[lon, lat]`) inside the Americas band, given a `RandomSource`.

**Requirements:** R1, R2, R7

**Dependencies:** U1

**Files:**
- Create: `src/sampler.ts`

**Approach:**
- Export an async function that takes a `RandomSource` and returns a GeoJSON `Position`.
- Latitude: loop calling `rng.next()` to produce `y` in `[-1, 1]` (i.e., `2 * u - 1`), compute `lat_deg = (π/2 - acos(y)) * 180/π`, accept when in `[-60, 35]`, otherwise re-loop.
- Longitude: one call to `rng.next()`, scaled to `[-120, -30]` uniformly.
- Return `[lon, lat]` per GeoJSON ordering.

**Patterns to follow:**
- `Position` type from `@types/geojson`; the function's return type names it explicitly so downstream code is GeoJSON-typed end to end.

**Test scenarios:**
- Test expectation: none — the formula is the user's specification; correctness is sanity-checked via console-driven smoke runs (e.g., a histogram over a few hundred samples in batch mode looks visibly cosine-weighted toward the equator).

**Verification:**
- The sampler's only RNG dependency is the injected `RandomSource`. No direct `Math.random` or `crypto` import.
- Returned `Position` values always satisfy `-120 <= lon <= -30` and `-60 <= lat <= 35`.

---

- U4. **GADM lookup and accept/reject filter**

**Goal:** Open the GADM geopackage once, expose a function that maps a sampled `Position` to either an accepted GeoJSON `Feature` (with country + level-1 properties) or a rejection signal.

**Requirements:** R3, R4, R5, R7, R11

**Dependencies:** None (independent of U1–U3)

**Files:**
- Create: `src/gadm.ts`
- Modify: `.gitignore` (ignore `data/`)

**Approach:**
- Export an `openGadm(path?: string)` function that resolves `GADM_PATH` (env > argument > default `data/gadm.gpkg`), opens the geopackage, and returns a small handle object exposing `lookup(position)` and `close()`.
- Discover the level-1 layer name and column names from the geopackage's schema at open time; throw a clear error if the layer is missing.
- `lookup(position)` performs a bbox query for features whose geometry envelope contains the point, then runs a precise point-in-polygon test to find the actual containing feature. If none, return a rejection (`{ kind: 'ocean' }`).
- If the containing feature has `GID_0 === 'USA'` and `NAME_1` is not in the allow-list (`'Puerto Rico'`, `'United States Virgin Islands'`), return a rejection (`{ kind: 'mainland-us' }`).
- Otherwise return `{ kind: 'accept', feature }`, where `feature` is typed as `Feature<Polygon | MultiPolygon, GadmProperties>` with `GadmProperties` carrying `gid_0`, `name_0`, `gid_1`, `name_1`.
- Open errors (file missing, bad path) print a message naming `GADM_PATH` and exit non-zero.

**Patterns to follow:**
- `@ngageoint/geopackage` async open + feature DAO patterns.
- `@types/geojson` `Feature`, `Polygon`, `MultiPolygon` types; do not invent project-local geometry types.

**Test scenarios:**
- Test expectation: none — verified by the smoke run in U5. Correctness against GADM is something the implementer eyeballs by checking that a known land coordinate (e.g., Mexico City) accepts and a known ocean coordinate rejects.

**Verification:**
- Calling `lookup` on a coordinate inside Mexico City returns `{ kind: 'accept', ... }` with `gid_0 === 'MEX'` and a reasonable `name_1`.
- Calling `lookup` on a coordinate inside mid-Pacific returns `{ kind: 'ocean' }`.
- Calling `lookup` on a coordinate inside Texas returns `{ kind: 'mainland-us' }`.
- Calling `lookup` on a coordinate inside Puerto Rico returns `{ kind: 'accept', ... }`.

---

- U5. **CLI entry, sample loop, and output formatters**

**Goal:** Wire everything together: parse args, select the RNG, open GADM, sample N accepted points, print them in the chosen format, close GADM.

**Requirements:** R6, R7, R8, R9, R10, R11

**Dependencies:** U1, U2, U3, U4

**Files:**
- Create: `src/format.ts`
- Modify: `src/index.ts`

**Approach:**
- `src/format.ts` exports two functions:
  - `formatHuman(features: Feature<Point, OutputProps>[]): string` — one block per result with `Latitude`, `Longitude`, `Country`, `Subdivision` lines, blank-line-separated.
  - `formatGeoJson(features: Feature<Point, OutputProps>[]): string` — wraps the array in a `FeatureCollection` and `JSON.stringify`s it (pretty-printed with 2-space indent for readability).
  - `OutputProps` carries `country`, `level1`, `gid_0`, `gid_1`.
- `src/index.ts`:
  - Parse args via `node:util` `parseArgs`. Recognize `--count`/`-n`, `--geojson`, `--rng`. Validate values (count is a positive integer; rng is one of the known names) and exit non-zero with usage text on bad input.
  - Construct the `RandomSource` from the registry.
  - Open GADM via `openGadm()`.
  - Loop until `count` accepted points have been produced: sample a `Position`, look it up; on accept, build a GeoJSON `Feature<Point, OutputProps>` from the sample and the GADM feature's properties, append to results.
  - On loop exit, print `formatHuman(results)` or `formatGeoJson(results)`.
  - Close GADM.

**Patterns to follow:**
- `node:util` `parseArgs` for the CLI.
- `@types/geojson` for `Feature`, `Point`, `FeatureCollection`.

**Test scenarios:**
- Test expectation: none — the project plan-of-record defers a test runner. Verification is by smoke runs across the three RNG choices and both output formats.

**Verification:**
- `yarn start` (no args) prints one human-readable result with non-empty `Country` and `Subdivision`.
- `yarn node src/index.ts --count 3` prints three blocks.
- `yarn node src/index.ts --count 2 --geojson` prints a parseable JSON `FeatureCollection` with two `Feature` entries, each `Point` geometry, and `country` / `level1` properties.
- `yarn node src/index.ts --rng math` and `--rng random.org` both run end-to-end and produce results.
- Bad input (`--count 0`, `--rng foo`) exits non-zero with usage text.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| GADM column names / layer name differ from the assumed GADM 4.x shape. | `openGadm()` discovers the layer and required columns at open time and throws a clear error naming what was missing — caught early, not deep in a sample loop. |
| `@ngageoint/geopackage`'s precise API differs from what the plan assumes. | Plan deliberately defers method selection to U4; the unit's verification scenarios pin behavior, not API names. |
| random.org's free-tier quota exhausts during a large batch. | Buffered fetches keep request count low; quota errors terminate the run with a clear message rather than silently blocking. The fix is to switch RNG with `--rng crypto`, surfaced in the error. |
| Native Node TS stripping rejects something the implementer writes (e.g., an enum). | `tsconfig.json` already has `erasableSyntaxOnly: true`, so `tsc --noEmit` (`yarn typecheck`) will catch it before runtime. |
| Large GADM file slow to bbox-query repeatedly in batch mode. | Open once per invocation and rely on the geopackage's built-in spatial index. If batch performance is a real problem, surface as a follow-up; not a v1 concern. |

---

## Documentation / Operational Notes

- Once U5 lands, update `README.md`'s Development section with a short "Usage" subsection naming the flags, the env var, and where to download the GADM geopackage.
- The `data/` directory will be gitignored; users are expected to drop their own `gadm.gpkg` there or set `GADM_PATH`.

---

## Sources & References

- `tsconfig.json`, `package.json`, `biome.json` (existing project conventions to honor)
- `src/index.ts` (current placeholder being replaced)
- `@ngageoint/geopackage` npm package
- `@types/geojson` npm package
- random.org plaintext API: https://www.random.org/clients/http/api/
