---
title: 'feat: Baseline tooling and conventions for fresh Node 24 / TS / Yarn PnP repo'
type: feat
status: active
date: 2026-05-06
---

# feat: Baseline tooling and conventions for fresh Node 24 / TS / Yarn PnP repo

## Summary

Establish baseline tooling for the fresh `americas` repo: Biome for lint+format with single-quoted strings, `package.json` scripts to type-check and run TypeScript directly via Node 24's native type-stripping under Yarn PnP, Yarn editor SDKs so language servers resolve packages, and a short README "Development" section so future contributors don't re-derive these choices.

---

## Problem Frame

`americas` is a brand-new internal Node 24 / TypeScript / Yarn 4 PnP project. The repo currently has only the bare scaffolding: `package.json`, `yarn.lock`, the PnP runtime, `.editorconfig`, `.gitignore`/`.gitattributes`, and the `@tsconfig/node24` preset just added. Before any application code lands, the repo needs lint, format, and run conventions so the first contributor doesn't have to make these decisions ad-hoc — and so the conventions are recorded once rather than re-litigated per PR.

---

## Requirements

- R1. Lint and format are handled by Biome via a single config file.
- R2. JS/TS strings default to single quotes via the formatter.
- R3. The project provides a command-line type-check.
- R4. TypeScript source files run directly with Node 24 (no transpile/build step) under Yarn PnP module resolution.
- R5. Editors and language servers can resolve TypeScript and Biome through Yarn PnP without per-machine setup.
- R6. The toolchain choices and run commands are recorded in-repo.

---

## Scope Boundaries

- Test runner, test files, coverage tooling.
- CI workflow (GitHub Actions or otherwise).
- Publishing flow, build step, bundler, exports map.
- Pre-commit hooks (lint-staged, husky, lefthook).
- Release tooling (changesets, semantic-release).
- Application code or domain logic.

---

## Context & Research

### Relevant Code and Patterns

- `package.json` — currently only `name` + `packageManager`. All scripts and dev dependency declarations land here.
- `tsconfig.json` — already extends `@tsconfig/node24/tsconfig.json`. Will need an `include` once `src/` exists so `tsc --noEmit` has inputs.
- `.editorconfig` — 2-space indent, LF line endings, final newline. Biome formatter settings should align.
- `.gitignore` — already configured for Yarn PnP, including the `!.yarn/sdks` allowlist that anticipates committed editor SDKs.

### External References

- Node.js native TypeScript support: Node 23.6+ runs `.ts` files directly without a flag (type-stripping). Node 24 carries this forward, so no `tsx` / `ts-node` is required.
- Biome documentation (`https://biomejs.dev`) — `biome.json` schema, `formatter.javascriptFormatter.quoteStyle`, recommended rule set.
- Yarn PnP editor SDKs (`https://yarnpkg.com/features/editor-sdks`) — `yarn dlx @yarnpkg/sdks` configures editor support so TS/Biome resolve under PnP.
- Running Node with PnP: `yarn node <file>` automatically loads the PnP runtime.

---

## Key Technical Decisions

- **Biome over ESLint+Prettier**: single tool, fast, zero-config-friendly, no legacy ESLint config to inherit.
- **Single-quoted strings**: explicit user preference. Configured via `formatter.javascriptFormatter.quoteStyle: "single"` in `biome.json`.
- **Native Node 24 TypeScript execution**: no `tsx`, `ts-node`, or build step. `node` strips types directly. Run via `yarn node` so the PnP runtime is loaded.
- **Type-checking via `tsc --noEmit`**: the only thing `tsc` does in this project. No `outDir`, no emit.
- **`"type": "module"`**: align with Node 24 and ESM-default conventions.
- **`engines.node` set to `>=24`**: matches the tsconfig preset and makes the runtime requirement explicit to package managers and CI later.
- **Commit Yarn editor SDKs** (`.yarn/sdks/`): the existing `.gitignore` already allowlists this path, so contributors get PnP-aware editor support without re-running the SDK generator.
- **Conventions live in `README.md`** rather than a separate `CONVENTIONS.md`: the repo is small enough that one document is preferable to two.

---

## Open Questions

### Resolved During Planning

- Conventions doc location — resolved: expand `README.md` rather than create a separate file.
- Need a `start`/`dev` script — resolved: yes, a minimal `start` that runs `yarn node src/index.ts`. Documents the run convention even before an entry exists.
- Whether Yarn SDKs are committed — resolved: yes, consistent with the existing `.gitignore` allowlist.

### Deferred to Implementation

- Exact Biome rule overrides beyond `recommended` — defer until real code exposes which rules are noisy.
- Whether to add a `src/index.ts` placeholder so `yarn typecheck` and `yarn start` exit cleanly — implementer decides based on whether an empty stub is acceptable.

---

## Implementation Units

- U1. **Add Biome with single-quote formatting and project scripts**

**Goal:** Install Biome and configure it as the single source of lint+format truth, with single-quoted strings and indentation aligned to EditorConfig.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `biome.json`
- Modify: `package.json` (add `@biomejs/biome` dev dependency; add `lint`, `format`, `check` scripts)

**Approach:**
- Add `@biomejs/biome` as a dev dependency via Yarn.
- Write `biome.json` with `$schema` pointed at the installed version, `formatter` enabled with 2-space indent and LF line endings, `javascriptFormatter.quoteStyle: 'single'`, and the `linter` recommended rule set enabled.
- Add npm scripts: `lint` (Biome lint), `format` (Biome format with write), `check` (Biome's combined check command — useful both interactively and when CI is added later).

**Patterns to follow:**
- Biome's documented `biome.json` schema. Pin the `$schema` URL to the installed Biome version so editor validation matches runtime behavior.

**Test scenarios:**
- Test expectation: none — pure tooling configuration; behavior is verified by running the scripts.

**Verification:**
- `yarn lint` exits 0 against the empty repo.
- `yarn format` rewrites a sample double-quoted string to single quotes when run on a scratch file.
- `biome.json` validates against its schema in editors that support `$schema`.

---

- U2. **Add type-check and run scripts; declare module type and Node engine**

**Goal:** Make `package.json` carry the typecheck script, the run script, and the runtime declarations.

**Requirements:** R3, R4

**Dependencies:** None (independent of U1)

**Files:**
- Modify: `package.json` (add `"type": "module"`, `engines.node`, `typecheck` and `start` scripts, `typescript` already a devDep)
- Modify: `tsconfig.json` (add `include: ['src/**/*']` so `tsc --noEmit` has a defined input set once `src/` exists)
- Create: `src/index.ts` (minimal placeholder so `yarn typecheck` and `yarn start` succeed against a real file)

**Approach:**
- Set `"type": "module"` so files are parsed as ESM by default.
- Add `engines.node: '>=24'`.
- Add `typecheck` script invoking `tsc --noEmit`.
- Add `start` script that runs the entry point under Yarn PnP: `yarn node src/index.ts` (so the PnP runtime is loaded).
- Add `src/` to `tsconfig.json` `include` so the type-checker has an input set.
- Create a one-line `src/index.ts` placeholder that uses single-quoted strings, demonstrating the convention and giving `start`/`typecheck` something real to run.

**Patterns to follow:**
- Conventional `package.json` script names: `start`, `typecheck`, `lint`, `format`, `check`.

**Test scenarios:**
- Test expectation: none — pure tooling configuration; verified by running each script.

**Verification:**
- `yarn typecheck` exits 0.
- `yarn start` runs `src/index.ts` under Node 24 with PnP loaded — does not error on module resolution or type stripping.
- `package.json` includes `"type": "module"` and `engines.node: '>=24'`.

---

- U3. **Generate and commit Yarn PnP editor SDKs**

**Goal:** Make TypeScript and Biome resolvable under Yarn PnP for editors and language servers without per-contributor setup.

**Requirements:** R5

**Dependencies:** U1 (Biome must be installed before its SDK shim can be generated)

**Files:**
- Create: `.yarn/sdks/` (Yarn-generated tree, committed per the existing `.gitignore` allowlist)
- Modify (potentially): `.vscode/settings.json` if Yarn's SDK generator emits one and its contents are obviously useful

**Approach:**
- Run `yarn dlx @yarnpkg/sdks base` to generate SDK shims for TypeScript and Biome.
- Commit the generated `.yarn/sdks/` tree.
- Review any editor-settings file Yarn writes; commit only the parts that point editors at the SDKs.

**Patterns to follow:**
- Yarn's documented PnP + SDK workflow.

**Test scenarios:**
- Test expectation: none — generated tooling artifacts.

**Verification:**
- `.yarn/sdks/typescript/` exists and is tracked.
- A Biome SDK entry exists under `.yarn/sdks/` (exact path depends on Yarn's current generator).
- `git status` after running the SDK generator is clean except for the committed SDK files.

---

- U4. **Document conventions in README**

**Goal:** Capture the chosen tools and run conventions in `README.md` so future contributors orient quickly.

**Requirements:** R6

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `README.md`

**Approach:**
- Expand `README.md` with a short "Development" section listing: Node 24 requirement, Yarn 4 PnP, TypeScript via `@tsconfig/node24`, Biome for lint/format with single quotes, the available `package.json` scripts, and a one-line note on running TS files (`yarn node src/file.ts`).
- Keep it terse — orientation, not a manual.

**Patterns to follow:**
- Standard README "Getting Started" / "Development" structure.

**Test scenarios:**
- Test expectation: none — documentation.

**Verification:**
- `README.md` lists each `package.json` script with a one-line purpose.
- `README.md` names the toolchain (Node 24, Yarn PnP, TypeScript, Biome) and the single-quote convention.

---

## System-Wide Impact

- **Interaction graph:** No runtime callers exist yet — this plan defines them.
- **State lifecycle risks:** None — no persistent state.
- **API surface parity:** None — no public surface yet.
- **Unchanged invariants:** The existing `tsconfig.json` extends `@tsconfig/node24` and that relationship is preserved. Yarn 4 PnP remains the package manager. EditorConfig settings (2-space, LF, final newline) are honored by the new Biome config rather than overridden.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Yarn PnP + Node native TS stripping interactions surprise us at runtime. | The `start` script uses `yarn node`, which loads the PnP runtime — the documented supported path. If it fails, fall back to `node --import ./.pnp.loader.mjs src/index.ts`. |
| Biome's recommended rule set evolves and shifts behavior across versions. | Pin `@biomejs/biome` to an exact version in `package.json`; bump intentionally. |
| `.yarn/sdks/` generated content drifts from the installed Biome/TS versions. | Note in `README.md` that SDKs should be regenerated after upgrading those tools (`yarn dlx @yarnpkg/sdks base`). |

---

## Documentation / Operational Notes

- The expanded `README.md` is the only documentation surface for now.
- No deployment or rollout steps — fresh repo with no consumers.

---

## Sources & References

- `tsconfig.json` (extends `@tsconfig/node24`)
- `.editorconfig`, `.gitignore`, `.gitattributes` (existing conventions to honor)
- Node.js native TypeScript support documentation
- Biome documentation: `https://biomejs.dev`
- Yarn PnP & editor SDK documentation: `https://yarnpkg.com/features/editor-sdks`
