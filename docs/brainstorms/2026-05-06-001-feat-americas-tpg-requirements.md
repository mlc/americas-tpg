---
date: 2026-05-06
topic: americas-tpg
---

# Américas TPG

## Summary

A turn-based geographic elimination game played as an operator-mediated CLI. Each round writes one GeoJSON file in `rounds/` containing a randomly sampled Americas target plus per-player submissions decorated with player name and km distance to the target; the active roster is fully derived from prior round files (no separate state). Last-place is eliminated each round, round 2+ also eliminates non-submitters, and one survivor wins.

***

## Problem Frame

The repo already samples a uniformly distributed land point in the Americas and resolves it to a country + admin-1 region. That primitive answered "give me one target." The multi-round elimination game it was pointed at was never built. A small group of would-be players exists, plus a single operator who relays between the code and the players via out-of-band comms (chat, voice, etc.). Without persisted game state, every round becomes operator bookkeeping: who's still in, who came farthest, who didn't show up. The round-2+ "did not submit" rule especially requires explicit memory of who was eligible — memory the operator currently has to maintain themselves, in their head or in a parallel spreadsheet.

***

## Actors

* A1. **Game Runner**: Single operator of the CLI. Runs create-round, runs update-submissions as submissions arrive, runs end-round. Relays target and elimination outcomes to players out-of-band. Sole source of truth for what each player submits.

* A2. **Player**: One of the eligible humans for a round. Receives the target from the runner out-of-band, decides on a `(lat, lng)` to submit, sends it to the runner out-of-band. Plays as long as they remain eligible.

***

## Key Flows

* F1. **Round creation**

  * **Trigger:** Runner decides a new round should begin.

  * **Actors:** A1

  * **Steps:**

    1. Runner runs the create-round script.
    2. Script samples a target via the existing sampler / RNG / GADM stack and writes a new round file under `rounds/` containing the target.
    3. Script prints the human-readable single-line target description to stdout.
    4. Runner relays the target to all eligible players out-of-band.

  * **Outcome:** A round file exists with a target and zero submissions; players have been notified.

  * **Covered by:** R1, R2, R3, R4

* F2. **Submission collection**

  * **Trigger:** A player sends the runner a `(lat, lng)` (and a name to attribute it under) via out-of-band channel.

  * **Actors:** A1, A2

  * **Steps:**

    1. Runner runs update-submissions with the round, the player name, and the coordinates.
    2. Script verifies the player's eligibility against the prior round (round 1 is open enrollment).
    3. If the player has not submitted this round, the new submission is appended; if they already have one, theirs is replaced.
    4. The submission is decorated with `player`, `distance` (km, via `@turf/distance`), and — when in a GADM polygon — `location` (string, `[level1, ] country`), then persisted to the round file.

  * **Outcome:** The round file reflects this player's current submission; the runner can run again as new submissions arrive.

  * **Covered by:** R6, R7, R8, R9, R10, R11

* F3. **Round end and elimination**

  * **Trigger:** Runner decides submissions are closed for the round.

  * **Actors:** A1

  * **Steps:**

    1. Runner runs end-round.
    2. Script computes last-place from the current round's submissions.
    3. For round N ≥ 2, script also computes did-not-submit eliminations against the prior round's eligible set.
    4. Script prints standings (each submitter + distance), the eliminated set, and either a winner declaration (when exactly one player would remain eligible going forward) or a stalemate notice (when zero would remain).
    5. Runner relays the result to players out-of-band, then either runs create-round for the next round or stops.

  * **Outcome:** Eliminations are determinable from the round file; the next round's eligibility is computable from what end-round confirmed.

  * **Covered by:** R12, R13, R14

***

## Requirements

**Round file**

* R1. A round is persisted as exactly one GeoJSON file under `rounds/` containing the round target and (over time) the per-player submissions.

* R2. The round target is generated using the repo's existing sampler / RNG / GADM lookup pipeline (uniform-on-Americas-band, mainland-US rejected, GADM-classified target).

* R3. create-round prints the target in the same human-readable single-line format the existing CLI emits.

* R4. create-round refuses to overwrite an existing round file; it must produce a new round, never mutate or replace an existing one.

**Roster derivation**

* R5. The active roster is fully derivable from `rounds/` content. There is no separate state file, no roster property in round files, and no external bookkeeping.

* R6. Round 1 is open enrollment: any player name accompanying a submission is considered eligible.

* R7. For round N ≥ 2, eligibility = the player submitted in round N-1 AND was not last-place in round N-1.

**Submissions**

* R8. update-submissions handles one player submission per invocation; the runner runs it again for each new submission.

* R9. If the player has not submitted yet this round, the submission is appended; if they have already submitted, theirs is replaced.

* R10. Each submission carries `player` (string), `distance` (number, km from target via `@turf/distance`), and — when GADM lookup resolves the coordinates — `location` (string, formatted as `[level1, ] country`) as GeoJSON feature properties. Submissions outside any GADM polygon (ocean, etc.) omit `location`.

* R11. update-submissions rejects submissions that violate eligibility (per R6, R7) or arrive after end-round has run for that round, with a clear error.

**Elimination**

* R12. end-round computes eliminations from the current round file plus, for round N ≥ 2, the prior round file: last-place (the farthest submission) is always eliminated; in round N ≥ 2, players who did not submit are also eliminated.

* R13. The player with the largest `distance` is always eliminated. Any other player whose `distance` is not at least 25 m (0.025 km) smaller than that largest distance is considered tied for last and is also eliminated.

* R14. end-round prints, for the round just ended: each submitter's distance to the target, the eliminated set, and either a winner declaration (when exactly one player would remain eligible going forward) or a stalemate notice (when zero would remain).

***

## Acceptance Examples

* AE1. **Covers R6, R7, R12.** Given round 1 has been created and Alice, Bob, and Carol all submit, end-round eliminates only the farthest of the three. Round 2 then accepts submissions from any of those three except whoever was last in round 1.

* AE2. **Covers R7, R12.** Given round 1 ended with Alice, Bob, and Carol surviving (Dan was last). In round 2, Alice and Bob submit but Carol does not. end-round eliminates the farther of Alice/Bob, plus Carol for not submitting.

* AE3. **Covers R11.** Given Dan was eliminated in round 1, his update-submissions invocation for round 2 is rejected.

* AE4. **Covers R13.** Given the two largest submission distances are 100.000 km and 100.020 km (within 25 m of each other), end-round eliminates both as tied for last.

* AE5. **Covers R14.** Given end-round runs and only one player remains eligible going forward, end-round prints a winner declaration alongside the standings.

* AE6. **Covers R14.** Given a round eliminates every remaining player (e.g., everyone tied for last; or in round N ≥ 2, the only submitter is also last), end-round prints a no-winner stalemate.

* AE7. **Covers R9.** Given Alice has already submitted `(12.0, -45.0)` for round 3, her second invocation with `(13.0, -46.0)` replaces the first submission rather than appending.

* AE8. **Covers R4.** Given a round file already exists for that round, create-round refuses to write and exits with an error.

***

## Success Criteria

* A multi-round Américas TPG game can be played end-to-end with the runner using only this repo's CLI plus an out-of-band channel — no spreadsheet, no notes file, no extra scratch state.

* A new game starts cleanly by emptying `rounds/`; an in-progress game is fully reconstructable from the current contents of `rounds/`.

* ce-plan can take this doc and produce an implementation plan without needing to invent rule semantics, file format basics, or operator script shapes.

***

## Scope Boundaries

* Photo handling of any kind in code (photos are out-of-band only; code stores no photo data).

* Player authentication, identity verification, anti-cheat, or location-spoofing detection. The runner trusts what they relay.

* Player ↔ runner communication channels (Slack, Discord, email, web UI, push). Comms are entirely the runner's responsibility.

* Web server, mobile app, GUI front-end, or any non-CLI interface.

* Round timers, submission deadlines, or scheduled cutoffs in code. The runner alone decides when to call end-round.

* Cross-game leaderboards, all-time stats, or game history beyond what naturally lives in `rounds/`.

* Geofencing or biasing the sampler toward populated/accessible regions. The existing uniform-on-Americas-band sampler is reused as-is.

* A separate roster file or `state.json`. State is derived from `rounds/` content.

* Multi-game concurrency in one repo. Starting over means archiving / clearing `rounds/`.

***

## Key Decisions

* **Roster is derived, not stored.** Eligibility flows from prior round file content (round 1 open; round N+1 = submitted-and-not-last in round N). Avoids a dual source of truth and keeps each round file a self-describing record of what happened.

* **Photos are out-of-band only.** Keeps the data model to `(player, lat, lng, distance, optional location)` and avoids EXIF, file storage, and validation complexity that adds nothing to game integrity (which the operator owns anyway).

* **Tie at last is defined by a 25 m buffer.** The farthest player is always eliminated; any other player whose `distance` is within 25 m of that farthest distance is considered tied and also eliminated. The buffer prevents near-identical submissions from being arbitrarily separated by sub-meter precision; no randomness or alphabetical tiebreaks.

* **One winner condition; stalemate is acceptable.** Game ends when exactly one player remains eligible (winner) or when zero remain (rare degenerate, no winner). No bend-the-rules re-runs.

* **One submission per invocation.** update-submissions is the runner's per-message tool; multiple invocations naturally accumulate during a round. Avoids batch-input ergonomics.

* **Runner-trusted, operator-mediated.** All human judgment (timeouts, dispute resolution, photo verification) lives outside the code; the CLI tracks mechanical state, not policy.

***

## Dependencies / Assumptions

* The existing `gadm.gpkg` data file is present at `data/gadm.gpkg` (or via `GADM_PATH`); create-round depends on it.

* A distance library (`@turf/distance` per the user's framing) is available for km computation. ce-plan confirms the exact dependency.

* Players have access to maps/devices that produce `(lat, lng)` to relay to the runner; the game is unplayable in fully offline player conditions.

***

## Outstanding Questions

### Resolve Before Planning

* (none — all product decisions resolved.)

### Deferred to Planning

* \[Affects R1, R4]\[Technical] Round file naming convention and round-number representation (zero-padded integers in filename, top-level GeoJSON property, both?). Affects "previous round" lookup and ordering.

* \[Affects R8]\[Technical] update-submissions argument shape (positional vs flagged, how the current round is identified).

* \[Affects R3, R14]\[Technical] Exact stdout format for multi-line outputs (standings, elimination summary, winner banner).

* \[Affects R2, F1]\[Technical] How the chosen RNG flows from create-round invocation (CLI flag mirroring existing `--rng`, env var, default).
