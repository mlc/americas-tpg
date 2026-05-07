# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small TypeScript CLI that draws uniformly distributed random points on the Earth's surface within an Americas-shaped lat/lon band, looks each one up in the GADM 4.10 administrative-boundaries geopackage, and reports the country + first-level subdivision (or rejects ocean / mainland-US hits and resamples). Output is either a human-readable line per point or a GeoJSON `FeatureCollection`.

## Toolchain (non-obvious bits)

- **Node 24+ with native TypeScript type-stripping.** No build step; `.ts` files run directly. Because of `erasableSyntaxOnly` in `tsconfig.json`, you cannot use `enum`, `namespace`, parameter properties, or other syntax that emits runtime code — stick to `type` / `interface` / `const` objects.
- **Yarn 4 + Plug'n'Play.** There is no `node_modules`. Always run TS files via `yarn node <file>` or the scripts below — bare `node src/foo.ts` will not resolve dependencies.
- **Imports use `.ts` extensions** (e.g. `./gadm.ts`) — that's `allowImportingTsExtensions`, not a typo.
- **Biome** does both lint and format. Single quotes, 2-space indent, LF.

## Commands

| Command | What it does |
| --- | --- |
| `yarn start` | Run `src/index.ts` (the CLI). |
| `yarn typecheck` | `tsc --noEmit` over `src/`. |
| `yarn lint` | Biome lint. |
| `yarn format` | Biome formatter, write fixes. |
| `yarn check` | Biome combined lint + format check (use this before committing). |
| `yarn node <file>` | Run any TS file under the PnP runtime. |

CLI flags: `--count <N>` (default 1), `--geojson`, `--rng <crypto|math|random.org>` (default `crypto`).

There is no test runner configured.

## Conventions

- **Pre-commit hook.** Husky + lint-staged runs `biome check --write` on staged files at commit time, so formatting/import-organize/safe lint fixes happen automatically. The hook activates via `yarn install` (`prepare: husky`). Don't add a separate "format the repo" step before committing — the hook handles it.
- **Commit messages: terse.** One-line conventional-commit subjects (`feat(scope): …`, `fix(scope): …`, `chore(hooks): …`). No multi-paragraph bodies unless the change genuinely needs the explanation. Match the existing log style.
- **Concurrency: not in scope.** The CLIs assume a single operator running commands serially. Race-condition findings (TOCTOU on round creation, concurrent `submit-round` writers losing updates, submit/end interleaving rolling back `ended_at`) are explicitly accepted as out-of-scope — if a user manages to run two commands at the same time, that's on them. Don't add locks, CAS, or `flag: 'wx'` exclusive opens. Don't surface concurrency findings during code review.

## Architecture

Pipeline lives in `src/index.ts` and composes four pieces:

1. **`rng.ts` / `rng-random-org.ts`** — `RandomSource` abstraction with three implementations: `crypto` (Node `randomBytes`, 53-bit float), `math` (`Math.random`), and `random.org` (HTTPS, fetches 200-value chunks with a 15s timeout and buffers them). `next()` is async because `random.org` is.
2. **`sampler.ts`** — `samplePosition(rng)` produces uniform-on-sphere samples by inverse-CDF on `sin(lat)` within a fixed bounding box (`lat ∈ [-60, 35]`, `lon ∈ [-120, -30]`). This box is rectangular and contains ocean + parts of the eastern Atlantic; non-Americas points are filtered out downstream by the GADM lookup, not by the sampler.
3. **`gadm.ts`** — opens `data/gadm.gpkg` (path overridable via `GADM_PATH` env var; file is gitignored, must be supplied locally) and exposes `lookup(position)` returning `{ kind: 'ocean' } | { kind: 'mainland-us' } | { kind: 'accept', feature }`. Mainland US is rejected by design; **Puerto Rico and the USVI come through as their own `GID_0` values (`PRI`, `VIR`) in GADM 4.10** — they are not children of `USA`, so rejecting `gid_0 === 'USA'` accepts them automatically. Don't "fix" that.
4. **`format.ts`** — `formatHuman` (one line per point, `lat°N/S lon°E/W, level1, country`) and `formatGeoJson` (FeatureCollection). `OutputProps` intentionally renames GADM's `GID_0`/`GID_1` to lowercase `gid0`/`gid1`.

`index.ts` loops `samplePosition → gadm.lookup`, discarding `ocean` / `mainland-us` results until it has `count` accepted points, then formats and prints. The GADM handle is closed in a `finally`.

### GADM lookup performance

`gadm.ts` is hot-path code and has two performance-driven choices that are easy to undo by accident:

- **`fastQueryBoundingBox`** with a tiny epsilon box around the query point, instead of scanning all features. Candidates are then point-in-polygon tested with `@turf/boolean-point-in-polygon`.
- **Lazy geometry parsing with a per-fid cache.** `parseFeatureRowIntoGeoJSON` is the expensive step; we only call it when a feature is a real candidate, and we memoize the parsed result (or `null` for non-polygon rows) keyed by `fid`. Recent commit history calls out a ~53× speedup from this combination — preserve it.

There is a deliberate type cast in `parseFeature` because `dao.fastQueryBoundingBox` returns rows that `dao.getRow` accepts at runtime but not per the declared `@ngageoint/geopackage` types. The runtime contract is load-bearing; the cast through `unknown` is intentional and commented in place.

## Data dependency

`data/gadm.gpkg` is the GADM 4.10 geopackage. It is gitignored and must exist locally. The code expects a feature table named `gadm_410` and properties `GID_0`, `NAME_0`, `GID_1`, `NAME_1`.

## Repo layout pointers

- `src/` — all source.
- `docs/plans/` — historical planning docs; read for context, not authoritative.
- `.yarn/sdks/` — committed PnP editor SDKs. Regenerate after upgrading TypeScript with `yarn dlx @yarnpkg/sdks base`.
