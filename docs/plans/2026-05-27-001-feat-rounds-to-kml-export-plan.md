---
title: "feat: Export all rounds to a single KML file"
type: feat
status: completed
date: 2026-05-27
---

# feat: Export all rounds to a single KML file

## Summary

Add a native TypeScript utility (`src/kml.ts`, run via the existing `build-kml`
script) that reads every **ended** `rounds/NNN.geojson` (in-progress rounds are
skipped, mirroring `leaderboard.ts`), transcribes the simplestyle
marker properties we already stamp on disk into KML `<Style>` elements, and
emits one KML `<Document>` where each round is its own `<Folder>` (KML's
notion of a layer). Every point's `<name>` is the player name, or `Target` for
the target. Built with `xmlbuilder2`, mirroring the `leaderboard.ts`
pure-builder + thin-CLI shape. This replaces the external `ogrmerge.py` (GDAL)
implementation the `build-kml` script currently shells out to.

---

## Problem Frame

The repo already has a `build-kml` package script, but it depends on
`ogrmerge.py` from GDAL — an external, non-JS toolchain dependency outside the
Node/Yarn-PnP world the rest of the project lives in, with no control over
naming, styling, or layer structure. We want a self-contained Node utility that
produces a KML whose styling matches the gold/silver/bronze/red/gray markers we
already compute, with readable per-round layers and player-named placemarks.

---

## Requirements

- R1. A utility reads every **ended** round file in the rounds directory
  (in-progress rounds are skipped) and emits a single KML document.
- R2. Each round becomes its own KML `<Folder>` (one layer per round), ordered
  by round number ascending.
- R3. Each placemark's `<name>` is the feature's `properties.player` — which is
  the literal `Target` for the target feature and the player name for
  submissions.
- R4. The subset of simplestyle we persist (`marker-symbol` ∈ {`star`,
  `circle`}, `marker-color` hex) is converted into KML `<Style>` elements:
  shared, defined once at `<Document>` level, referenced via `<styleUrl>`.
- R5. `marker-color` (`#rrggbb`) is converted to KML's `aabbggrr` byte order
  (`aa` always `ff` — full, fixed opacity): `#rrggbb` → `ff` + `bb` + `gg` + `rr`.
- R6. `marker-symbol` maps to a Google-hosted shape icon href (`star` →
  `star.png`, `circle` → `placemark_circle.png`), tinted by the converted color.
- R7. Output is valid, well-formed KML 2.2 that opens in Google Earth; player
  names with XML-special characters or emoji are correctly escaped.
- R8. Built with `xmlbuilder2`; runnable via the `build-kml` yarn script.

---

## Scope Boundaries

- Not converting back from KML to GeoJSON — export only.
- Not rendering elimination/podium logic anew — the tool transcribes the
  `marker-*` properties already on disk; it never recomputes eliminations.
- Not adding per-feature `<description>`, distance balloons, timestamps, or
  `<LabelStyle>` tuning. Names + styled points + per-round folders only.
- Not changing the round file format, the simplestyle writer, or any other CLI.
- Not localizing folder/placemark names (KML stays English/`player`-verbatim,
  consistent with how submission locations stay GADM English).

### Deferred to Follow-Up Work

- Richer placemark content (distance, location, elimination status in a
  `<description>`): future iteration if desired.
- Per-round style variants beyond the existing 6 marker combos: not needed now.

---

## Context & Research

### Relevant Code and Patterns

- `src/leaderboard.ts` — the structural template: a pure builder
  (`buildLeaderboardMarkdown`) plus a thin `generateLeaderboard` (reads files)
  and a `main()` CLI guarded by `isMain`. `targetsMap` shows iterating
  `RoundFile[]` into a derived artifact. Mirror this layout in `src/kml.ts`.
- `src/round-file.ts` — `listRoundFiles(dir)` returns sorted `{ round, path }[]`;
  `readRound(path)` validates and returns a `RoundFile`. Reuse both verbatim;
  do not re-implement directory scanning.
- `src/simplestyle.ts` — `SIMPLESTYLE` const holds the canonical hex colors and
  the `star`/`circle` symbols. Import it as the single source of truth for any
  defaulting/fallback; the conversion reads each feature's stamped properties
  rather than recomputing.
- `src/round-domain.ts` — `RoundFile`, `targetOf`, `submissionsOf`. Every
  feature (target and submission) carries `properties.player`, so `<name>` is
  uniformly `feature.properties.player` (the target's is the literal
  `'Target'`). `roundInfo.number` drives the folder name.
- `src/list-countries.ts` — minimal read-only CLI skeleton (`parseArgs`,
  `USAGE`, `fail`, `isMain`, `try/catch` with `isParseArgsError` /
  `exitWithError`). Match this for argument handling.
- `src/cli-helpers.ts` — `isMain`, `isParseArgsError`, `exitWithError` reused as-is.
- `package.json` — `build-kml` currently `ogrmerge.py -dsco NameField=player -o
  rounds.kml -f kml rounds/*`; default output filename is `rounds.kml`.

### Institutional Learnings

- On-disk features already carry `marker-symbol`/`marker-color` because
  `applySimplestyle` runs on every `writeRoundAtomic`. The KML tool is a pure
  transcriber of those values — this keeps elimination logic in exactly one
  place (CLAUDE.md "GADM lookup performance" / simplestyle invariants).
- `erasableSyntaxOnly` (CLAUDE.md toolchain): no `enum`/`namespace`/parameter
  properties — use `const` objects, `type`/`interface`, plain functions.
- Yarn PnP: `xmlbuilder2` must be added through Yarn and the file run via
  `yarn node` / a package script; a bare `node` invocation won't resolve it.

### External References

- KML 2.2 reference: `<Style>`/`<IconStyle>`/`<Icon>`/`<styleUrl>`, color order
  is `aabbggrr` (alpha, blue, green, red) — the inverse byte order of CSS/web
  `#rrggbb`. `<coordinates>` is `lon,lat[,alt]`, same lon-first order as GeoJSON
  Positions, so no axis swap is needed.
- `xmlbuilder2` (3.x): `create(...).ele(...).txt(...).up()...end({ prettyPrint:
  true })`; auto-escapes text and attribute content (the reason to use it over
  string concatenation — player names like `Martin 🇳🇱` or names containing
  `&`/`<` are handled correctly).
- Google-hosted shape icons:
  `http://maps.google.com/mapfiles/kml/shapes/star.png` and
  `.../placemark_circle.png`.

---

## Key Technical Decisions

- **Transcribe, don't recompute.** Read `properties['marker-symbol']` and
  `properties['marker-color']` straight off each feature. The KML tool has no
  knowledge of eliminations, podium, or DNS — it only converts styling already
  written. Rationale: single source of truth, decoupled from game logic, and a
  literal reading of "convert the subset of simplestyle that we write."
- **Shared styles, referenced by `styleUrl`.** Collect the distinct
  `(symbol, color)` pairs across all features, emit one `<Style id=...>` per
  pair at `<Document>` level (deterministic id order), and reference via
  `<styleUrl>#id</styleUrl>`. Smaller file, idiomatic KML. Style id scheme:
  `s_<symbol>_<hex6-without-#>` (e.g. `s_star_000000`, `s_circle_d4af37`).
- **Round = `<Folder>`.** Folders are KML's layer primitive; Google Earth and
  most consumers treat top-level folders as toggleable layers. Folder `<name>` =
  `Round ${roundInfo.number}`.
- **`<name>` = `properties.player` uniformly.** Works for target (`'Target'`)
  and submissions without special-casing, because the round format deliberately
  gives the target the same property shape.
- **Color conversion** `#rrggbb` → `ff` + `bb` + `gg` + `rr` (full opacity).
  Exposed as a standalone exported function for direct unit testing.
- **Icon href by symbol** (per user decision): `star` → `star.png`, `circle` →
  `placemark_circle.png`; tinted by `<IconStyle><color>`. Unknown/missing symbol
  falls back to the `circle` symbol (`placemark_circle.png`); unknown/missing
  color falls back to `SIMPLESTYLE.DEFAULT_PLAYER` (`#444444` gray) — i.e. a gray
  circle.
- **`marker-*` are runtime props, not in the domain types.** `applySimplestyle`
  stamps `marker-symbol`/`marker-color` on every feature on write, but they are
  **not** declared in `TargetProperties`/`SubmissionProperties` (round-domain.ts).
  The builder must read them through a small typed accessor (e.g. a `MarkerProps`
  index-lookup over `feature.properties`), not by assuming the domain types
  expose them. Do not widen the domain types as part of this change.
- **Include only ended rounds** (`roundInfo.endedAt !== null`). `generateKml`
  skips in-progress rounds — mirroring `generateLeaderboard`'s ended-only filter
  — and throws if there are zero ended rounds. The active round is excluded
  because its markers aren't final (and a freshly created round is target-only
  until the first `submit-round`). The pure `buildRoundsKml` stays ended- and
  submission-count-agnostic: it transcribes whatever `RoundFile`s it is handed
  and throws only on an empty array; the ended filter lives in `generateKml`.
- **`build-kml` repointed** (per user decision) to `yarn node src/kml.ts`;
  ogrmerge dropped. Default output filename stays `rounds.kml` for continuity;
  `--rounds-dir` and `-o`/`--output` flags follow the existing CLI conventions.

---

## Open Questions

### Resolved During Planning

- Icon rendering for `marker-symbol`: **Google-hosted shape icons, tinted** (user).
- Fate of the existing `build-kml`/ogrmerge script: **repoint `build-kml` to the
  native tool** (user).
- Which rounds to include: **ended only** (in-progress rounds excluded, per
  user — mirrors `leaderboard.ts`).
- `<name>` source: `properties.player` for every feature (uniform).
- `rounds.kml` gitignore: **resolved — add it to `.gitignore` in U1** (known
  answer; it's a generated, untracked artifact).

### Deferred to Implementation

- Exact `xmlbuilder2` call chain / whether to assemble via nested `.ele()` or a
  JS object passed to `create()` — pick whichever reads cleanest once writing.
- Whether to emit `lon,lat` or `lon,lat,0` in `<coordinates>` — both are
  spec-valid; default to `lon,lat` unless a target consumer complains.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for
> review, not implementation specification. The implementing agent should treat
> it as context, not code to reproduce.*

Output shape (one Document, shared styles, one Folder per round):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Américas TPG Rounds</name>

    <!-- one <Style> per distinct (symbol, color) across all features -->
    <Style id="s_star_000000">
      <IconStyle>
        <color>ff000000</color>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/star.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="s_circle_d4af37">
      <IconStyle>
        <color>ff37afd4</color>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
    </Style>
    <!-- … silver / bronze / red / gray circle styles … -->

    <Folder>
      <name>Round 1</name>
      <Placemark>
        <name>Target</name>
        <styleUrl>#s_star_000000</styleUrl>
        <Point><coordinates>-66.55809,-26.2263</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Palin</name>
        <styleUrl>#s_circle_d4af37</styleUrl>
        <Point><coordinates>-65.9755558,-26.0736488</coordinates></Point>
      </Placemark>
      <!-- … remaining submissions … -->
    </Folder>
    <!-- … <Folder> per remaining round … -->
  </Document>
</kml>
```

Pipeline: `listRoundFiles(dir)` → `readRound` each → `buildRoundsKml(rounds)`
(collect distinct styles → emit Document/styles/folders → serialize) → write to
output path.

---

## Implementation Units

- U1. **Add `xmlbuilder2` dependency and repoint the `build-kml` script**

**Goal:** Make `xmlbuilder2` resolvable under Yarn PnP and have `build-kml` run
the native tool instead of ogrmerge.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `package.json` (add `xmlbuilder2` to `dependencies`; change
  `build-kml` to `yarn node src/kml.ts`)
- Modify: `.gitignore` (add `rounds.kml` — the default generated artifact)

**Approach:**
- Add `xmlbuilder2` (current 3.x) via Yarn so the lockfile and `.pnp` data are
  updated — do not hand-edit only the `dependencies` block.
- Replace the `build-kml` script value with `yarn node src/kml.ts`.
- Add `rounds.kml` to `.gitignore`. It is currently not ignored, and the
  pre-commit lint-staged hook + `git add -A` would otherwise sweep the generated
  KML into a commit on the first run.

**Test scenarios:**
- Test expectation: none — dependency/script wiring, exercised by U3's behavior
  tests and a manual `yarn build-kml` run in U2's verification.

**Verification:**
- `xmlbuilder2` imports successfully under `yarn node`; `yarn build-kml` invokes
  the native script (after U2 lands).

---

- U2. **`src/kml.ts`: pure KML builder, color/icon helpers, and CLI**

**Goal:** Read all ended rounds and emit the styled, layered KML document;
expose a pure builder for testing and a thin CLI for `build-kml`.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** U1

**Files:**
- Create: `src/kml.ts`
- Test: `tests/kml.test.ts` (authored in U3)

**Approach:**
- `simplestyleColorToKml(hex: string): string` — strip `#`, reorder to
  `ff` + bb + gg + rr, lowercase. Exported for direct unit testing. Falls back
  to `SIMPLESTYLE.DEFAULT_PLAYER` on malformed/missing input.
- `iconHrefForSymbol(symbol: string): string` — `star` → star.png, else
  placemark_circle.png.
- `styleIdFor(symbol, hex)` → `s_<symbol>_<hex6>`.
- `buildRoundsKml(rounds: readonly RoundFile[]): string` — pure. Throws on empty
  input. Walk all features to collect the distinct `(symbol, color)` set; emit
  one `<Style>` each (sorted by id for determinism). Then one `<Folder>` per
  round (input order; caller passes them sorted), each containing a `<Placemark>`
  per feature with `<name>` = `properties.player`, `<styleUrl>` = the matching
  style id, and `<Point><coordinates>lon,lat</coordinates>`. Serialize with
  `xmlbuilder2` `prettyPrint`. Let the library handle XML escaping.
- `generateKml(deps: { roundsDir: string }): Promise<{ kml: string; rounds: number }>`
  — `listRoundFiles` → `readRound` each (already sorted ascending) → **filter to
  ended** (`endedAt !== null`) → `buildRoundsKml`. Throws if zero ended rounds
  (mirrors `generateLeaderboard`).
- `main()` — `parseArgs` with `--rounds-dir`, `-o`/`--output` (default
  `rounds.kml`), `-h`/`--help`; write the file; print
  `wrote <output> (<n> round(s))`. Guard with `isMain`; `try/catch` routing
  `isParseArgsError` → `fail` (USAGE), else `exitWithError`.

**Patterns to follow:**
- `src/leaderboard.ts` (builder + `generate*` + `main`, USAGE/`fail`,
  `isMain` block, exit message phrasing).
- `src/list-countries.ts` (minimal read-only CLI / arg parsing).

**Test scenarios:** *(authored in U3; listed here so the builder's contract is explicit)*
- Happy path: 2-round input → output has one `<Document>`, two `<Folder>`s named
  `Round 1` / `Round 2`, each with one `<Placemark>` per feature; target
  placemark `<name>` is `Target`.
- Happy path: submission placemark `<name>` equals `properties.player` verbatim.
- Edge case: player name with XML-special chars (`A & B`, `x<y`) and emoji
  (`Martin 🇳🇱`) is emitted escaped and re-parses to the original string.
- Happy path (color conversion): `simplestyleColorToKml('#d4af37') === 'ff37afd4'`,
  `'#000000' → 'ff000000'`, `'#ff0000' → 'ff0000ff'`.
- Happy path (style dedup): given features spanning K distinct `(symbol,color)`
  pairs, output has exactly K `<Style>` elements and every `<Placemark>`
  `<styleUrl>` references one of them.
- Happy path (icon href): a `star` feature's style points at `star.png`; a
  `circle` feature's at `placemark_circle.png`.
- Happy path (coordinates): `<coordinates>` is `lon,lat` in that order, taken
  from `geometry.coordinates`.
- Edge case (`generateKml`): in-progress rounds (`endedAt: null`) are excluded;
  only ended rounds appear in the output (mirrors `generateLeaderboard`).
- Edge case (`generateKml`): a rounds dir with zero ended rounds throws.
- Edge case (`buildRoundsKml`): a target-only round fixture (`features:
  [target]`, zero submissions) yields a `<Folder>` with exactly one `<Placemark>`
  named `Target` and no error — the pure builder is submission-count-agnostic.
- Edge case: feature missing `marker-*` props falls back to default gray circle
  rather than throwing.
- Error path: empty `rounds` array throws (`buildRoundsKml`).
- Integration (well-formedness): output parses as XML with root `<kml>` and the
  KML 2.2 namespace.

**Verification:**
- `yarn build-kml` writes `rounds.kml`; the file opens in Google Earth with one
  toggleable layer per round and correctly colored, named markers.
- `yarn typecheck`, `yarn lint`, `yarn check` pass.

---

- U3. **Tests: `tests/kml.test.ts`**

**Goal:** Lock the builder contract with Node's built-in test runner.

**Requirements:** R1–R7

**Dependencies:** U2

**Files:**
- Create: `tests/kml.test.ts`

**Approach:**
- Construct minimal `RoundFile` literals in-test (don't depend on disk), as
  `tests/leaderboard.test.ts` does. Assert against the returned KML string —
  prefer parsing it back (via `xmlbuilder2` or a DOM/parse helper) and asserting
  on structure where practical, plus targeted substring/attribute checks for
  colors, hrefs, names, and `<coordinates>`.
- Unit-test `simplestyleColorToKml` directly across the SIMPLESTYLE palette.

**Patterns to follow:**
- `tests/leaderboard.test.ts` (RoundFile fixtures, pure-builder assertions).
- Test command: `node --test` per `package.json` `test` script.

**Test scenarios:** see the enumerated list under U2 — implement each.

**Verification:**
- `yarn test` passes including the new file.

---

- U4. **Docs: CODE.md and CLAUDE.md**

**Goal:** Document the new export for operators and AI agents; keep RULES.md and
README.md untouched.

**Requirements:** R1–R8 (documentation of)

**Dependencies:** U2

**Files:**
- Modify: `CODE.md` (operator-facing: what `yarn build-kml` does now, flags,
  output file, that it replaced the ogrmerge approach)
- Modify: `CLAUDE.md` (commands table row for `build-kml`; a short architecture
  note that `src/kml.ts` is a pure transcriber of on-disk `marker-*` props,
  round = `<Folder>`, KML `aabbggrr` color order)

**Approach:**
- CODE.md gets the human run instructions and file-format notes.
- CLAUDE.md gets the invariant/non-obvious notes (color byte-order gotcha,
  transcribe-don't-recompute, `<name>` = `properties.player`).
- Do **not** edit `RULES.md` (player-facing) or grow `README.md` (sign-post).

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- `yarn check` passes (Biome touches Markdown formatting via the pre-commit
  hook); commands table and prose accurately describe the shipped behavior.

---

## System-Wide Impact

- **Interaction graph:** New leaf module. Imports `round-file.ts`,
  `round-domain.ts`, `simplestyle.ts`, `cli-helpers.ts`; nothing imports
  `kml.ts`. No change to the sampler, round CLIs, or round file format.
- **External contract:** `build-kml` script semantics change (ogrmerge → native;
  same output filename `rounds.kml`). Anyone relying on GDAL being invoked loses
  that, gains a Node-only path. New `-o`/`--rounds-dir` flags are additive.
  Behavior also tightens: ogrmerge globbed every file in `rounds/`; the native
  tool exports **ended rounds only**, skipping the active/in-progress round.
- **State lifecycle risks:** Read-only over `rounds/`; writes only the output
  KML. No round files mutated.
- **Unchanged invariants:** Round file format, simplestyle writer, elimination
  logic, all other CLIs untouched. The KML tool consumes the `marker-*`
  properties but does not influence how they're computed.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| KML color byte-order (`aabbggrr`) emitted wrong (web `#rrggbb` order) | Dedicated, unit-tested `simplestyleColorToKml`; assert exact strings for gold/black/red. |
| Player names break XML (`&`, `<`, emoji) | Use `xmlbuilder2` text/attr nodes (auto-escape); test with adversarial names and re-parse. |
| Google-hosted icon hrefs unavailable offline / at view time | Accepted per user choice; colors still convey rank, target still distinct. Noted in docs. |
| `xmlbuilder2` not resolving under Yarn PnP | Add via Yarn (updates lockfile + `.pnp`), run via `yarn node`/script — never bare `node`. |
| `rounds.kml` accidentally committed | Add `rounds.kml` to `.gitignore` in U1 (it is not ignored today). |

---

## Documentation / Operational Notes

- Update `CODE.md` (operator usage) and `CLAUDE.md` (commands table + invariants)
  in U4. Leave `RULES.md` and `README.md` alone per repo doc conventions.
- Operators run `yarn build-kml` (optionally `--rounds-dir`, `-o`); default
  output `rounds.kml`.

---

## Sources & References

- Pattern: `src/leaderboard.ts`, `src/list-countries.ts`
- Reuse: `src/round-file.ts` (`listRoundFiles`, `readRound`),
  `src/round-domain.ts`, `src/simplestyle.ts` (`SIMPLESTYLE`)
- KML 2.2 spec (Style/IconStyle/Folder/coordinates, `aabbggrr` color order)
- `xmlbuilder2` 3.x docs
