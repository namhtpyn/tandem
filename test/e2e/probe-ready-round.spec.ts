import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the READY-ROUND arm (#443) reads a task in a
// `ready` or `working` category that owns a PENDING row of its CURRENT round for a LIVE AI
// reviewer, with NO running run and the row past the 5-minute grace, and WITHOUT an owner
// status write newer than that row. That is the parked round a legal egress left behind:
// before 2.78.26 the note-dispatch bounce flipped a parked task back to work and left the
// round (no sweep reaches a ready task — the stalled-review and lost-settle scans require
// review-flow ownership), so the reviewer never decided. From the floor the flip tears
// every open round down in the same transaction, so the arm is gated at that release.
//
// The manual-freedom exception is pinned both ways: a manual move out of review leaves the
// round's PENDING rows behind and is LEGAL, identified by its owner status write (`status:
// …` body + the 1:1 kind='STATUS' payload, tasks.setStatus's signature) newer than the
// row — while the machine egress that produced the bug logs its own body and must fire.
// It is also pinned that the arm does NOT carry the stalled-review never-dispatched clause:
// a parked reviewer WAS dispatched (its turn failed), so importing it would hide the shape.
//
// The detector is pinned by the SQL that ships: the probe emits it (--strand-sql) and this
// spec executes exactly those bytes against the e2e database — no test-side copy.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

/** fixed uuids — the reviewer columns are uuid-typed (a readable string 22P02s) */
const AI_USER = '01a14743-0000-7000-8000-0000000004a1';
const HUMAN_USER = '01a14743-0000-7000-8000-0000000004a2';

test.describe('prod probe ready-round arm (#443)', () => {
  test('fires only on a ready/working task whose round a machine egress left open', async () => {
    // gate: the arm must be ABSENT below the release whose note-dispatch flip tears the
    // round down (there the shape is produced by a legal send), and present at/above it
    const below = await $`bash ${script} --strand-sql 2.78.25 2`.nothrow().quiet();
    expect(below.exitCode).toBe(0);
    expect(below.stdout.toString()).not.toContain("select 'readyround'");
    const emitted = await $`bash ${script} --strand-sql 2.78.26 2`.nothrow().quiet();
    expect(emitted.exitCode).toBe(0);
    const sqlText = emitted.stdout.toString();
    expect(sqlText).toContain("select 'readyround'");
    // the parked reviewer WAS dispatched — the stalled arm's never-dispatched clause must
    // never ride this arm, or the exact #443 shape is excluded from the only arm that sees
    // it (pinned on the arm's own slice: the lostsettle arm legitimately carries 'DONE')
    const arm = sqlText.slice(sqlText.indexOf("select 'readyround'"), sqlText.indexOf("select 'orphanhome'"));
    expect(arm).toContain("tr.status = 'RUNNING'");
    expect(arm).not.toContain("tr.status = 'DONE'");

    const db = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      // one environment + the live AI reviewer + a human (the non-AI control), all SQL-side:
      // this arm is a pure read, so the seed must express the shapes, not drive the UI
      await db.unsafe(
        `insert into environments (id, name, host, username, created_at, updated_at)
         values ('e2e-env-443', $1, '127.0.0.1', 'e2e', now(), now())`,
        [`E2E Ready Env ${Date.now().toString(36)}`],
      );
      await db.unsafe(
        `insert into "user" (id, name, email, email_verified, created_at, updated_at) values
           ($1, 'E2E Ready Bot', $3, false, now(), now()),
           ($2, 'E2E Ready Human', $4, false, now(), now())`,
        [
          AI_USER,
          HUMAN_USER,
          `e2e-ready-bot-${process.pid}@tandem.local`,
          `e2e-ready-human-${process.pid}@tandem.local`,
        ],
      );
      await db.unsafe(
        `insert into ai_employees (user_id, environment_id, executable, created_at, updated_at)
         values ($1, 'e2e-env-443', 'hermes acp', now(), now())`,
        [AI_USER],
      );

      const seed: Array<{ id: string; status: string }> = [
        { id: 'e2e-ready-fire', status: TODO },
        { id: 'e2e-ready-working-fire', status: DOING },
        { id: 'e2e-ready-legal-move', status: TODO },
        { id: 'e2e-ready-live-run', status: TODO },
        { id: 'e2e-ready-fresh', status: TODO },
        { id: 'e2e-ready-old-round', status: TODO },
        { id: 'e2e-ready-human', status: TODO },
        { id: 'e2e-ready-void', status: TODO },
        { id: 'e2e-ready-paused', status: BLOCKED },
        // the declared legal shape: an answer that landed while a verdict was held and lost
        // the repair flip to the dispatcher's claim — the round stays open on a ready task
        // with only a thread note. Its free-text twin (a NOTE carrying the same words) must
        // NOT silence the arm: the exclusion keys on the machine payload kind.
        { id: 'e2e-ready-hold', status: TODO },
        { id: 'e2e-ready-hold-fake', status: TODO },
      ];
      for (const t of seed) {
        await db.unsafe(
          `insert into tasks (id, title, status, created_at, updated_at) values ($1, $1, $2, now(), now())`,
          [t.id, t.status],
        );
      }

      // the shape: PENDING row in the CURRENT round, 10 minutes old, AI reviewer
      const pending = (taskId: string, round = 1, reviewer: string | null = AI_USER, ageMin = 10) =>
        db.unsafe(
          `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at)
           values ($1, $2, $3, $4, 'PENDING', 'ai', now() - ($5::int * interval '1 minute'))`,
          [`rev-${taskId}-${round}`, taskId, reviewer, round, ageMin],
        );
      await pending('e2e-ready-fire');
      await pending('e2e-ready-working-fire');
      await pending('e2e-ready-legal-move');
      await pending('e2e-ready-live-run');
      await pending('e2e-ready-fresh', 1, AI_USER, 1);
      // round 2 is the CURRENT round and it is decided: the round-1 PENDING row is stale
      // debris of a resubmit (legal — a manual move out of review leaves it), not this shape
      await pending('e2e-ready-old-round', 1);
      await db.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ('rev-old-round-2', 'e2e-ready-old-round', $1, 2, 'APPROVED', 'ai', now() - interval '20 minutes', now() - interval '19 minutes')`,
        [AI_USER],
      );
      await pending('e2e-ready-human', 1, HUMAN_USER);
      await pending('e2e-ready-void', 1, null);
      await pending('e2e-ready-paused');
      await pending('e2e-ready-hold');
      await pending('e2e-ready-hold-fake');

      // a RUNNING run on the task: the round is not provably stranded while work is live
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at) values ('msg-live-run', 'e2e-ready-live-run', 'go', now())`,
      );
      await db.unsafe(
        `insert into task_runs (id, message_id, employee_id, status, started_at)
         values ('run-live', 'msg-live-run', $1, 'RUNNING', now() - interval '2 minutes')`,
        [AI_USER],
      );

      // the manual-freedom control: the owner's move out of review AFTER the round minted —
      // body prefix + 1:1 kind='STATUS' payload, exactly the writer's signature
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-legal-move', 'e2e-ready-legal-move', $1, now() - interval '1 minute')`,
        [`status: ${IN_REVIEW} → ${TODO}`],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values ('msg-legal-move', '{"kind":"STATUS"}'::jsonb)`,
      );
      // free text cannot forge the discriminator: a NOTE that merely starts with `status: `
      // (no kind='STATUS' payload) must NOT silence the arm
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-fake-move', 'e2e-ready-fire', $1, now())`,
        [`status: ${IN_REVIEW} → ${TODO} (this is just a note)`],
      );

      // HOLD-LANDING: the declared legal shape carries the machine resume note (STATUS kind,
      // written after the row it re-opened) — excluded; the same words as a NOTE (payload
      // kind NOTE) cannot borrow it.
      const resumeBody =
        'review round resumed — the answer landed while a verdict was being held; the task moved again, owner unblock to in-review re-fires the held reviewer';
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at) values
           ('msg-hold-note', 'e2e-ready-hold', $1, now() - interval '1 minute'),
           ('msg-hold-fake', 'e2e-ready-hold-fake', $1, now() - interval '1 minute')`,
        [resumeBody],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values
           ('msg-hold-note', '{"kind":"STATUS","reviewResumed":true}'::jsonb),
           ('msg-hold-fake', '{"kind":"NOTE"}'::jsonb)`,
      );

      const rows = (await db.unsafe(sqlText)) as Array<{ readyround?: string }>;
      // the emission is one row per arm label — find the ready-round row's id list
      const out = rows.map((r) => Object.values(r).join('|')).find((v) => v.startsWith('readyround|'));
      expect(out).toBeTruthy();
      const ids = (out as string).split('|')[1]!.split(',').filter(Boolean).sort();
      // ready + working tasks whose round a machine egress left open; nothing else.
      // 'e2e-ready-hold-fake' FIRES: same body, NOTE payload — free text cannot forge the
      // hold-landing exclusion.
      expect(ids).toEqual(['e2e-ready-fire', 'e2e-ready-hold-fake', 'e2e-ready-working-fire']);
    } finally {
      await db.close();
    }
  });
});
