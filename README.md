# americas

## Development

- **Runtime:** Node.js >= 24. TypeScript runs directly via Node's native type-stripping — no transpile step.
- **Package manager:** Yarn 4 (Plug'n'Play). Install with `yarn install`.
- **TypeScript:** configured by extending `@tsconfig/node24`.
- **Lint and format:** Biome. Strings are single-quoted; indentation is 2-space, line endings LF.
- **Editor support:** Yarn PnP SDKs are committed under `.yarn/sdks/`. After upgrading TypeScript or other SDK-aware tools, regenerate with `yarn dlx @yarnpkg/sdks base`.

### Scripts

| Command | What it does |
| --- | --- |
| `yarn start` | Run `src/index.ts` under Node 24 with the PnP runtime loaded. |
| `yarn typecheck` | Run `tsc --noEmit` against `src/`. |
| `yarn lint` | Run Biome's linter. |
| `yarn format` | Run Biome's formatter and write fixes. |
| `yarn check` | Run Biome's combined lint + format check. |

### Running TypeScript files

Use `yarn node <file>` so the Yarn PnP runtime is loaded:

```sh
yarn node src/index.ts
```
