import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "SETTLE-SWEEP ATOMICITY" — the DECIDED-ROUND HEAL (#472): the #467
// settle transaction's declared crash boundary (a hard kill rolls back to "task in
// review, this round decided" — verdict CAS committed, no PENDING row, no flip) is
// replayed from the round's own verdict rows by the 5s dispatcher tick, never by a fresh
// turn. This spec executes the live path: the app's own tick must settle the machine
// shape, must NOT touch the #430 legal manual re-queue, and must respect the 60s grace
// that keeps it off a settle that is still landing.
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const CANCELLED = '01a14743-43f5-759d-a00e-b0f2a5a04f4c';

async function seedDecidedTask(
  sql: SQL,
  id: string,
  reviewerId: string | null,
  opts: {
    writtenMinutes: number;
    decidedSeconds: number;
    ownerMoveMinutes?: number;
    source?: string;
    verdict?: string;
  },
) {
  await sql.unsafe(
    `insert into tasks (id, title, status, created_at, updated_at)
     values ($1, $1, $2, now(), now() - ($3::int * interval '1 minute'))`,
    [id, IN_REVIEW, opts.writtenMinutes],
  );
  await sql.unsafe(
    `insert into task_reviews (id, task_id, reviewer_id, round, status, note, source, created_at, decided_at)
     values ($1, $2, $3, 1, $6, 'looks good', $5, now() - interval '30 minutes', now() - ($4::int * interval '1 second'))`,
    [`rev-${id}`, id, reviewerId, opts.decidedSeconds, opts.source ?? 'human', opts.verdict ?? 'APPROVED'],
  );
  if (opts.ownerMoveMinutes !== undefined) {
    const messageId = `msg-${id}`;
    await sql.unsafe(
      `insert into task_messages (id, task_id, author_id, body, created_at)
       values ($1, $2, $3, $4, now() - ($5::int * interval '1 minute'))`,
      [messageId, id, reviewerId, 'status: doing → in-review', opts.ownerMoveMinutes],
    );
    await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
      messageId,
      { kind: 'STATUS' },
    ]);
  }
}

async function statusOf(sql: SQL, taskId: string): Promise<string> {
  const rows = await sql.unsafe('select status from tasks where id = $1', [taskId]);
  return String((rows[0] as { status?: string } | undefined)?.status ?? '');
}

async function waitForStatus(sql: SQL, taskId: string, want: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await statusOf(sql, taskId)) === want) return true;
    await Bun.sleep(500);
  }
  return false;
}

test.describe('decided-round heal (#472)', () => {
  test('the tick replays the machine shape only — legal re-queue and the grace are silent', async () => {
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for a live-reviewer seed').not.toBe('');

      const tag = crypto.randomUUID();
      const heal = `e2e-decided-heal-${tag}`; // machine shape: verdict 5 min old, no owner move
      const legal = `e2e-decided-legal-${tag}`; // #430 legal re-queue: the owner move is newer than the verdict
      const fresh = `e2e-decided-fresh-${tag}`; // inside the 60s grace: a settle could still be landing
      const removed = `e2e-decided-removed-${tag}`; // the deciding reviewer was deleted after the crash (FK-nulled row)
      const rejected = `e2e-decided-rejected-${tag}`; // the all-rejected matrix arm -> cancelled
      const changes = `e2e-decided-changes-${tag}`; // the request-change matrix arm -> back to ready

      await seedDecidedTask(sql, heal, adminId, { writtenMinutes: 10, decidedSeconds: 300 });
      await seedDecidedTask(sql, legal, adminId, { writtenMinutes: 10, decidedSeconds: 300, ownerMoveMinutes: 1 });
      await seedDecidedTask(sql, fresh, adminId, { writtenMinutes: 10, decidedSeconds: 10 });
      await seedDecidedTask(sql, removed, null, { writtenMinutes: 10, decidedSeconds: 300 });
      await seedDecidedTask(sql, rejected, adminId, { writtenMinutes: 10, decidedSeconds: 300, verdict: 'REJECTED' });
      await seedDecidedTask(sql, changes, adminId, {
        writtenMinutes: 10,
        decidedSeconds: 300,
        verdict: 'CHANGE_REQUESTED',
      });

      expect(await waitForStatus(sql, heal, DONE, 20_000), 'the tick must replay the lost settle to DONE').toBe(true);
      expect(
        await waitForStatus(sql, removed, DONE, 20_000),
        'a decided round whose reviewer was deleted (FK-nulled row) still settles',
      ).toBe(true);
      expect(
        await waitForStatus(sql, rejected, CANCELLED, 20_000),
        'the all-rejected matrix arm replays to cancelled',
      ).toBe(true);
      expect(
        await waitForStatus(sql, changes, TODO, 20_000),
        'the request-change matrix arm replays back to ready',
      ).toBe(true);

      // the replay is the SAME settle: its verdict note landed exactly once
      const notes = await sql.unsafe(
        `select payload->>'kind' as kind, payload->>'approved' as approved, count(*)::int as n
         from task_message_activities a join task_messages m on m.id = a.message_id
         where m.task_id = $1 and a.payload->>'kind' = 'VERDICT'
         group by 1, 2`,
        [heal],
      );
      expect(notes.length, 'the replayed settle logs its verdict note').toBe(1);
      expect(Number((notes[0] as { n?: number }).n)).toBe(1);

      // the legal re-queue and the grace shape are never stomped
      expect(await statusOf(sql, legal), 'a legal manual re-queue over a decided round is not a machine wedge').toBe(
        IN_REVIEW,
      );
      expect(await statusOf(sql, fresh), 'a verdict inside the 60s grace may still be settling — never replayed').toBe(
        IN_REVIEW,
      );
    } finally {
      await sql.end();
    }
  });
});
