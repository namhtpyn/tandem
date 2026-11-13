import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the READY-ROUND arm (#443, task-wide per #445)
// reads a `ready` or `working` category task that owns a PENDING row of ANY round for a
// LIVE AI reviewer, with NO running run and the row past the 5-minute grace, WITHOUT an
// owner status write newer than that row, and WITHOUT a machine resume note newer than
// that row. That is the parked/stranded round: before 2.78.26 the note-dispatch bounce
// flipped a parked task back to work and left the round (no sweep reaches a ready task —
// the stalled-review and lost-settle scans require review-flow ownership), so the reviewer
// never decided. From the floor the flip tears every open round down in the same
// transaction, so the arm is gated at that release.
//
// The law is TASK-WIDE (#445): a ready task must own no live round AT ALL. Pinning the
// clause to `round = max(round)` hid an older-round strand — a resubmit opens the next
// round insert-only and older rows are never superseded, so a teardown regression leaving
// ONLY non-current-round rows alerted never. The old `e2e-ready-old-round` control asserted
// silence on exactly that seed; #445 reverses it: the seed fires, and the spec pins the
// absence of the max-round subselect on the arm's own bytes.
//
// The manual-freedom exception is pinned both ways, PER ROUND (keyed on each row's own
// created_at, never the task's latest write): a manual move out of review leaves the
// round's PENDING rows behind and is LEGAL, identified by its owner status write (`status:
// …` body + the 1:1 kind='STATUS' payload, tasks.setStatus's signature) newer than THAT row
// — while the machine egress that produced the bug logs its own body and must fire. A
// verdict record (the round-2 decision) does NOT exclude an older-round strand: the strand
// is the alert. It is also pinned that the arm does NOT carry the stalled-review
// never-dispatched clause: a parked reviewer WAS dispatched (its turn failed), so importing
// it would hide the shape.
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

test.describe('prod probe ready-round arm (#443, task-wide per #445)', () => {
  test('fires on any live round a machine egress left open; only the declared per-row records silence it', async () => {
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
    // #445: the round clause is task-wide — the max-round subselect must be GONE (it hid an
    // older-round strand behind a decided newer round)
    expect(arm).not.toContain('r.round = (select max');

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
        // the shipped current-round shapes: a machine egress left the live round open
        { id: 'e2e-ready-fire', status: TODO },
        { id: 'e2e-ready-working-fire', status: DOING },
        // the manual-freedom legal shape: owner moved out of review after the row minted
        { id: 'e2e-ready-legal-move', status: TODO },
        { id: 'e2e-ready-live-run', status: TODO },
        { id: 'e2e-ready-fresh', status: TODO },
        // #445: the older-round strand — round 1 PENDING under a DECIDED round 2, no
        // exclusion record anywhere. The old arm pinned `round = max` and was silent; the
        // task-wide law fires it (a resubmit supersedes nothing, so the strand is live and
        // unreachable — the teardown-regression / direct-SQL class this arm exists for).
        { id: 'e2e-ready-old-round', status: TODO },
        // #445 empirical seed with the round-2 verdict record present: a verdict does NOT
        // exclude the strand (only the two declared machine-egress records do)
        { id: 'e2e-ready-old-verdict', status: TODO },
        // per-round exclusion: the manual move's own record is newer than THAT row only —
        // the older-round twin is silent under the same law
        { id: 'e2e-ready-old-move', status: TODO },
        // per-round exclusion, hold-landing twin: the resume note is newer than THAT row
        { id: 'e2e-ready-old-hold', status: TODO },
        // BOTH rounds live, each row covered by a newer record (r1 by the owner move
        // minted after it, r2 by the resume note minted after it): silent. r2's ONLY
        // cover is the resume note, so this is the hold-gap patch-out target at task
        // grain; the owner-gap patch-out target is `e2e-ready-old-move` (+ `legal-move`).
        { id: 'e2e-ready-old-both', status: TODO },
        // the GRANULARITY pin (#445 r1 review): r1 covered by its own newer record, r2
        // live and uncovered — the arm must fire via r2. This is the only seed that
        // distinguishes per-row exclusion from a per-task keying on the OLDEST pending
        // row (a min-keyed mutant silences the whole task via r1's cover and goes red
        // here). Keying on the NEWEST row is not a distinct corruption: any record newer
        // than the youngest row necessarily covers every older row, so max-keying is
        // semantically equivalent to per-row for these exclusion records.
        { id: 'e2e-ready-old-mix', status: TODO },
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
      // #445: round 1 PENDING under a decided round 2 — the strand the max-round clause hid
      await pending('e2e-ready-old-round', 1);
      await db.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ('rev-old-round-2', 'e2e-ready-old-round', $1, 2, 'APPROVED', 'ai', now() - interval '20 minutes', now() - interval '19 minutes')`,
        [AI_USER],
      );
      // the verdict twin: same strand, and the round-2 decision ALSO wrote its record —
      // a real human VERDICT message (kind='VERDICT' payload, newer than the round-1 row)
      // does NOT silence the arm: only the two declared machine-egress records exclude,
      // so a hypothetical VERDICT-keyed-exclusion mutant goes red here
      await pending('e2e-ready-old-verdict', 1);
      await db.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ('rev-old-verdict-2', 'e2e-ready-old-verdict', $1, 2, 'APPROVED', 'human', now() - interval '20 minutes', now() - interval '19 minutes')`,
        [HUMAN_USER],
      );
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-old-verdict', 'e2e-ready-old-verdict', $1, now() - interval '18 minutes')`,
        ['changes requested — round 2 decided'],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload)
         values ('msg-old-verdict', '{"kind":"VERDICT","approved":true,"round":2}'::jsonb)`,
      );
      // per-round exclusions: each strand is silenced only by a record newer than ITSELF
      await pending('e2e-ready-old-move', 1);
      await db.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ('rev-old-move-2', 'e2e-ready-old-move', $1, 2, 'APPROVED', 'ai', now() - interval '20 minutes', now() - interval '19 minutes')`,
        [AI_USER],
      );
      await pending('e2e-ready-old-hold', 1);
      await db.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ('rev-old-hold-2', 'e2e-ready-old-hold', $1, 2, 'APPROVED', 'ai', now() - interval '20 minutes', now() - interval '19 minutes')`,
        [AI_USER],
      );
      // both rounds live, each row covered: r1@-12 by the owner move @-11, r2@-8 by the
      // resume note @-7 (the note also happens to cover r1 — r2's cover is hold-only)
      await pending('e2e-ready-old-both', 1, AI_USER, 12);
      await pending('e2e-ready-old-both', 2, AI_USER, 8);
      // the granularity pin: r1@-12 covered by the move @-11; r2@-8 uncovered → FIRES via r2
      await pending('e2e-ready-old-mix', 1, AI_USER, 12);
      await pending('e2e-ready-old-mix', 2, AI_USER, 8);
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
      // the per-round owner-move record: newer than e2e-ready-old-move's round-1 row
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-old-move', 'e2e-ready-old-move', $1, now() - interval '1 minute')`,
        [`status: ${IN_REVIEW} → ${TODO}`],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values ('msg-old-move', '{"kind":"STATUS"}'::jsonb)`,
      );
      // the per-round pair: r1@-12 covered by the owner move @-11; r2@-8 covered by the
      // resume note @-7 — each row's own newer record, never the task's latest
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at) values
           ('msg-both-move', 'e2e-ready-old-both', $1, now() - interval '11 minutes'),
           ('msg-both-hold', 'e2e-ready-old-both', $2, now() - interval '7 minutes')`,
        [`status: ${IN_REVIEW} → ${TODO}`, `review round resumed — owner unblock re-fires the held reviewer`],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values
           ('msg-both-move', '{"kind":"STATUS"}'::jsonb),
           ('msg-both-hold', '{"kind":"STATUS","reviewResumed":true}'::jsonb)`,
      );
      // the granularity seed's cover: the move @-11 covers r1@-12; r2@-8 stays uncovered
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-mix-move', 'e2e-ready-old-mix', $1, now() - interval '11 minutes')`,
        [`status: ${IN_REVIEW} → ${TODO}`],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values ('msg-mix-move', '{"kind":"STATUS"}'::jsonb)`,
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
      // the per-round hold twin: the resume note is newer than old-hold's round-1 row only
      await db.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         values ('msg-old-hold', 'e2e-ready-old-hold', $1, now() - interval '1 minute')`,
        [resumeBody],
      );
      await db.unsafe(
        `insert into task_message_activities (message_id, payload) values ('msg-old-hold', '{"kind":"STATUS","reviewResumed":true}'::jsonb)`,
      );

      const rows = (await db.unsafe(sqlText)) as Array<{ readyround?: string }>;
      // the emission is one row per arm label — find the ready-round row's id list
      const out = rows.map((r) => Object.values(r).join('|')).find((v) => v.startsWith('readyround|'));
      expect(out).toBeTruthy();
      const ids = (out as string).split('|')[1]!.split(',').filter(Boolean).sort();
      // ready + working tasks whose round a machine egress left open — now ANY round:
      // 'e2e-ready-old-round' FIRES (#445: the strand the max-round clause hid);
      // 'e2e-ready-old-verdict' FIRES (a verdict record is not an exclusion record);
      // 'e2e-ready-old-mix' FIRES via its uncovered round-2 row (the per-row-vs-per-task
      // granularity pin); 'e2e-ready-hold-fake' FIRES: same body, NOTE payload — free text
      // cannot forge the
      // hold-landing exclusion. The per-round twins ('e2e-ready-old-move', 'e2e-ready-old-
      // hold', 'e2e-ready-old-both') stay silent: each row excluded by its OWN newer record.
      expect(ids).toEqual([
        'e2e-ready-fire',
        'e2e-ready-hold-fake',
        'e2e-ready-old-mix',
        'e2e-ready-old-round',
        'e2e-ready-old-verdict',
        'e2e-ready-working-fire',
      ]);
    } finally {
      await db.close();
    }
  });
});
