# americas

A small TypeScript CLI that draws uniformly distributed random points within an
Americas-shaped lat/lon band and resolves each one to its country and first
administrative subdivision via the GADM 4.10 geopackage. Mainland USA and South
Georgia/SSI are excluded from selection — the southern boundary is conceptually
the Antarctic Convergence.

It also implements **TPG**, a turn-based geo-guessing game built on top of the
same sampler: each round picks a random Americas target, players submit a
coordinate, the farthest guess (with a 25 m tie buffer) is eliminated, and the
last surviving player wins.

## Development

- **Runtime:** Node.js >= 24. TypeScript runs directly via Node's native type-stripping — no transpile step.
- **Package manager:** Yarn 4 (Plug'n'Play). Install with `yarn install`.
- **TypeScript:** configured by extending `@tsconfig/node24`.
- **Lint and format:** Biome. Strings are single-quoted; indentation is 2-space, line endings LF.
- **Editor support:** Yarn PnP SDKs are committed under `.yarn/sdks/`. After upgrading TypeScript or other SDK-aware tools, regenerate with `yarn dlx @yarnpkg/sdks base`.

### Scripts

| Command | What it does |
| --- | --- |
| `yarn start` | Sample random Americas points (`src/index.ts`). |
| `yarn list-countries` | Print every non-excluded country reachable by the sampler. |
| `yarn create-round` | Start a new round of TPG. |
| `yarn submit-round` | Submit a player's coordinate guess to the active round. |
| `yarn end-round` | Close the active round, compute eliminations, and print standings. |
| `yarn send-reminders` | List players eligible for the active round who have not yet submitted. Prints a Discord-pasteable message with @-mentions and a submission-tracker link. |
| `yarn leaderboard` | Regenerate `LEADERBOARD.md` from every ended round. Survivors first (alphabetical), then eliminated players (most-recently-eliminated first, names italicized). Cells are integer-km distances, bold on the round of elimination, `DNS` when a player was eligible but did not submit, blank when out or not yet joined. |
| `yarn test` | Run the test suite (`node --test`). |
| `yarn typecheck` | Run `tsc --noEmit` against `src/`. |
| `yarn lint` | Run Biome's linter. |
| `yarn format` | Run Biome's formatter and write fixes. |
| `yarn check` | Run Biome's combined lint + format check. |

### Running TypeScript files

Use `yarn node <file>` so the Yarn PnP runtime is loaded:

```sh
yarn node src/index.ts
```

## Sampling random points

```sh
yarn start --count 5            # five human-readable lines
yarn start --geojson --count 10 # GeoJSON FeatureCollection
yarn start --rng random.org     # use random.org as the entropy source
```

`--rng` accepts `crypto` (default), `math`, or `random.org`.

## TPG

Round files are written to `rounds/NNN.geojson` (override with `--rounds-dir`).
The on-disk format is plain RFC 7946 GeoJSON: a `FeatureCollection` carrying a
`roundInfo` foreign member (`number`, `endedAt`, optional `language`) whose
first feature is the target (with the location label) and whose remaining
features are player submissions.

```sh
# Round 1: pick a target
yarn create-round

# Each player submits a coordinate.
# The coordinate may be a single quoted string or two positionals; decimal
# (with `.` or `,` as the decimal separator), NESW, and DMS forms are all
# accepted.
yarn submit-round alice "40.7128, -74.0060"
yarn submit-round bob   "40°42'46\"N 74°00'21\"W"
yarn submit-round carol 19.43 -99.13
yarn submit-round dani  "40,7128 -74,0060"

# Close the round, print standings, and stamp endedAt on roundInfo.
yarn end-round

# Then start round 2; only players who survived round 1 may submit.
yarn create-round
```

Coordinates that begin with a `-` need either single-quoted form
(`"-30, -50"`) or a `--` separator before the positional
(`yarn submit-round bob -- "-30" "-50"`), since `-30` would otherwise look
like an option flag.

The map markers in each round file follow the
[simplestyle 1.1 spec](https://github.com/mapbox/simplestyle-spec/blob/master/1.1.0/README.md):
the target is a black star, players are circles colored gold/silver/bronze for
1st/2nd/3rd, red for last place (using the same 25 m tie rule), and gray
otherwise. Colors are recomputed on every write.

## Data dependency

`data/gadm.gpkg` is the GADM 4.10 administrative-boundaries geopackage. It is
gitignored and must be supplied locally; set `GADM_PATH` to point elsewhere.
