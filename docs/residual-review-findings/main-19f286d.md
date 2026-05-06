# Residual Review Findings — main @ 19f286d

Source: ce-code-review autofix run `20260506-011315-a8cfc6f4`
Plan: `docs/plans/2026-05-06-001-feat-baseline-tooling-conventions-plan.md`
Run artifact: `/tmp/compound-engineering/ce-code-review/20260506-011315-a8cfc6f4/`

No issue tracker is configured (no git remote, no `gh` repo). Findings recorded inline as the durable record.

## Residual Review Findings

- **P1 — `package.json:14` — `@types/node ^25` mismatches Node 24 runtime; type surface advertises APIs not present in 24** (gated_auto)
  Suggested fix: pin `@types/node` to `^24` to match the runtime engine and avoid type-API drift.

- **P1 — `tsconfig.json:1` — Native type-stripping intent not asserted locally** (manual)
  Suggested fix: pin `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`, `erasableSyntaxOnly` in `compilerOptions` so the project's intent survives `@tsconfig/node24` preset upgrades.

- **P2 — `tsconfig.json:1` — `strict` on but `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` are off** (manual)
  Suggested fix: enable these compiler options before any application code lands; this is the cheapest moment.

## Advisory (no action required)

- No `AGENTS.md` / `CLAUDE.md` exists yet — capture conventions once tooling stabilizes (Biome single-quote style, Yarn 4 PnP, native Node TS execution, package.json script names, `src/` layout).
- `docs/solutions/` does not exist — once tooling stabilizes, run `/ce-compound` to seed it with the decisions made here.
- Agent-native parity holds by construction: every capability is a `yarn` script invokable through the shell. Preserve this property as the project grows.

## Dropped false positives (verified during review)

- Reviewer claimed `typescript ^6.0.3` does not exist on npm. `yarn info typescript` reports `typescript@npm:6.0.3` resolves; `tsc --showConfig` and `yarn typecheck` both succeed. Reviewer's training data predates the release.
- Reviewer flagged that Biome may descend into `.yarn/sdks`. `yarn biome check .` reports 5 files (the project sources only); `.yarn/sdks` is excluded by Biome's built-in ignores. Errors only surface when `.yarn/sdks` is passed explicitly, which no project script does.
