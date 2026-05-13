import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  type RoundFile,
  type SubmissionFeature,
  submissionTrackerUrl,
  type TargetFeature,
} from '../src/round-domain.ts';
import { roundPath, writeRoundAtomic } from '../src/round-file.ts';
import { sendReminders } from '../src/send-reminders.ts';
import { withEliminated } from './test-helpers.ts';

function makeArgentinaTarget(): TargetFeature {
  return {
    type: 'Feature',
    id: 'target',
    geometry: { type: 'Point', coordinates: [-67.5, -42.5] },
    properties: {
      player: 'Target',
      distance: null,
      location: 'Río Negro, Argentina',
    },
  };
}

function makeRound(
  round: number,
  endedAt: string | null,
  submissions: SubmissionFeature[] = [],
): RoundFile {
  return {
    type: 'FeatureCollection',
    roundInfo: {
      number: round,
      endedAt,
      ...(endedAt !== null ? { dnsChecks: [] } : {}),
    },
    features: [makeArgentinaTarget(), ...submissions],
  };
}

function makeSubmission(player: string, distance: number): SubmissionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { player, distance },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tpg-send-reminders-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sendReminders', () => {
  test('round 1 errors — no prior round to derive eligibility from', async () => {
    await writeRoundAtomic(roundPath(1, dir), makeRound(1, null));
    await assert.rejects(sendReminders({ roundsDir: dir }), /round 1/);
  });

  test('lists round-2 survivors who have not yet submitted', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30),
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 5)]),
    );

    const result = await sendReminders({ roundsDir: dir });
    assert.equal(result.round, 2);
    assert.deepEqual([...result.pending], ['bob']);
    assert.match(
      result.message,
      /^Round 2, 1\/2 submissions received, round ends at <t:\d+:t>\n@bob\n/,
    );
  });

  test('all eligible submitted omits the ping line but keeps the header', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30),
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [
        makeSubmission('alice', 5),
        makeSubmission('bob', 8),
      ]),
    );

    const result = await sendReminders({ roundsDir: dir });
    assert.deepEqual([...result.pending], []);
    assert.match(
      result.message,
      /^Round 2, 2\/2 submissions received, round ends at <t:\d+:t>\n\[Submission Tracker\]/,
    );
  });

  test('eliminated player from prior round is excluded from pending list', async () => {
    // dan was eliminated in round 1 and (somehow) has a submission in round 2.
    // Eligibility is derived from the prior round's `eliminated === false` set,
    // not from current-round submitters, so dan must not appear in pending.
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('alice', 10),
          makeSubmission('bob', 20),
          makeSubmission('dan', 30),
        ],
        ['dan'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('dan', 1)]),
    );

    const result = await sendReminders({ roundsDir: dir });
    assert.deepEqual([...result.pending], ['alice', 'bob']);
  });

  test('ended current round rejects', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated([makeSubmission('alice', 10)], []),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    const r2 = makeRound(
      2,
      '2026-05-07T12:00:00Z',
      withEliminated([makeSubmission('alice', 5)], []),
    );
    await writeRoundAtomic(roundPath(2, dir), r2);

    await assert.rejects(
      sendReminders({ roundsDir: dir, explicitRound: 2 }),
      /ended/,
    );
  });

  test('--round N path matches implicit case', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [makeSubmission('alice', 10), makeSubmission('bob', 20)],
        ['bob'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    const explicit = await sendReminders({ roundsDir: dir, explicitRound: 2 });
    const implicit = await sendReminders({ roundsDir: dir });
    assert.deepEqual([...explicit.pending], [...implicit.pending]);
    assert.equal(explicit.message, implicit.message);
  });

  test('pending list is alphabetically sorted', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated(
        [
          makeSubmission('charlie', 10),
          makeSubmission('alice', 11),
          makeSubmission('bob', 12),
          makeSubmission('zara', 30),
        ],
        ['zara'],
      ),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));

    const result = await sendReminders({ roundsDir: dir });
    assert.deepEqual([...result.pending], ['alice', 'bob', 'charlie']);
  });

  test('message contains submission tracker URL in both branches', async () => {
    const r1 = makeRound(
      1,
      '2026-05-06T12:00:00Z',
      withEliminated([makeSubmission('alice', 10)], []),
    );
    await writeRoundAtomic(roundPath(1, dir), r1);
    const trackerUrl = submissionTrackerUrl(2);

    // Non-empty branch — alice still owes a submission.
    await writeRoundAtomic(roundPath(2, dir), makeRound(2, null));
    const pending = await sendReminders({ roundsDir: dir });
    assert.ok(
      pending.message.includes(`[Submission Tracker](${trackerUrl})`),
      `non-empty message should contain tracker link; got: ${pending.message}`,
    );

    // Empty branch — alice has now submitted.
    await writeRoundAtomic(
      roundPath(2, dir),
      makeRound(2, null, [makeSubmission('alice', 5)]),
    );
    const empty = await sendReminders({ roundsDir: dir });
    assert.deepEqual([...empty.pending], []);
    assert.ok(
      empty.message.includes(`[Submission Tracker](${trackerUrl})`),
      `empty message should contain tracker link; got: ${empty.message}`,
    );
  });
});
