import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "ESCALATION-HANDOFF HEAL" (#474) — the referral handoff writes the
// ESCALATED row, the roster, the replacement's row, the obligations and the activity in
// SEPARATE statements. The flip's own statement persists the target
// (task_reviews.referral_target_id), so the 5s tick can re-fire a handoff that crashed
// after it: roster rewritten, replacement PENDING row minted (the round×reviewer unique
// index keeps it idempotent), approval obligation moved, escalation activity logged, a
// targeted AI turn dispatched — NEVER a settle. The same referral makes the round
// UNSETTLEABLE until the target's row exists: a concurrent verdict stands on its row and
// the task stays in review (a matrix that settles unanimity without the owed vote is the
// bug this pins).
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

async function seedUser(sql: SQL, id: string, name: string) {
  await sql.unsafe('insert into "user" (id, name, email, created_at, updated_at) values ($1, $2, $3, now(), now())', [
    id,
    name,
    `${id}@tandem.local`,
  ]);
}

async function seedReviewTask(
  sql: SQL,
  id: string,
  opts: { reviewers: string[]; assigneeId: string; createdMinutes?: number },
) {
  await sql.unsafe(
    `insert into tasks (id, title, status, assignee_id, reviewers, created_at, updated_at)
     values ($1, $1, $2, $3, $4::text[], now() - ($5::int * interval '1 minute'), now() - ($5::int * interval '1 minute'))`,
    [id, IN_REVIEW, opts.assigneeId, opts.reviewers, opts.createdMinutes ?? 30],
  );
}

async function seedRow(
  sql: SQL,
  opts: {
    taskId: string;
    reviewerId: string | null;
    status: string;
    referralTargetId?: string | null;
    createdAtSeconds: number;
    decidedAtSeconds?: number;
    note?: string;
  },
) {
  await sql.unsafe(
    `insert into task_reviews (id, task_id, reviewer_id, round, status, note, source, referral_target_id, created_at, decided_at)
     values ($1, $2, $3, 1, $4, $5, $6, $7,
             now() - ($8::int * interval '1 second'),
             case when $9::int is null then null else now() - ($9::int * interval '1 second') end)`,
    [
      `rev-${crypto.randomUUID()}`,
      opts.taskId,
      opts.reviewerId,
      opts.status,
      opts.note ?? null,
      opts.reviewerId ? 'ai' : null,
      opts.referralTargetId ?? null,
      opts.createdAtSeconds,
      opts.decidedAtSeconds ?? null,
    ],
  );
}

async function statusOf(sql: SQL, taskId: string): Promise<string> {
  const rows = await sql.unsafe('select status from tasks where id = $1', [taskId]);
  return String((rows[0] as { status?: string } | undefined)?.status ?? '');
}

async function targetRowCount(sql: SQL, taskId: string, targetId: string): Promise<number> {
  const rows = await sql.unsafe(
    'select count(*)::int as n from task_reviews where task_id = $1 and round = 1 and reviewer_id = $2',
    [taskId, targetId],
  );
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

test.describe('escalation-handoff heal (#474)', () => {
  test('the tick re-fires a crashed referral — mint, roster, activity, never a settle', async () => {
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const assignee = crypto.randomUUID();
      const escalator = crypto.randomUUID();
      const target = crypto.randomUUID();
      await seedUser(sql, assignee, `E2E Assignee ${tag}`);
      await seedUser(sql, escalator, `E2E Escalator ${tag}`);
      await seedUser(sql, target, `E2E Target ${tag}`);

      const taskId = `e2e-handoff-heal-${tag}`;
      // the crash shape: the escalator's flip landed, the roster still carries the
      // escalator, the replacement's row and its activity never landed — 5 minutes old,
      // well past the 60s grace
      await seedReviewTask(sql, taskId, { reviewers: [escalator], assigneeId: assignee });
      await seedRow(sql, {
        taskId,
        reviewerId: escalator,
        status: 'ESCALATED',
        referralTargetId: target,
        note: 'escalate to E2E Target for reviewing — wrong domain',
        createdAtSeconds: 1800,
        decidedAtSeconds: 300,
      });

      // the 5s tick re-fires the referral
      const end = Date.now() + 20_000;
      while (Date.now() < end && (await targetRowCount(sql, taskId, target)) === 0) await Bun.sleep(500);
      expect(await targetRowCount(sql, taskId, target), 'the replacement PENDING row is minted').toBe(1);

      const row = (
        await sql.unsafe(
          'select status, source from task_reviews where task_id = $1 and round = 1 and reviewer_id = $2',
          [taskId, target],
        )
      )[0] as { status?: string } | undefined;
      expect(row?.status, 'the replacement row is a PENDING vote, never a verdict').toBe('PENDING');

      const roster = (await sql.unsafe('select reviewers from tasks where id = $1', [taskId]))[0] as
        | { reviewers?: string[] }
        | undefined;
      expect(roster?.reviewers, 'the roster hands the vote over: escalator out, target in').toEqual([target]);

      const acts = await sql.unsafe(
        `select a.payload->>'recovered' as recovered, a.payload->>'to' as target
         from task_message_activities a join task_messages m on m.id = a.message_id
         where m.task_id = $1 and a.payload->>'escalated' = 'true'`,
        [taskId],
      );
      expect(acts.length, 'the re-fire logs the escalation activity exactly once').toBe(1);
      expect((acts[0] as { recovered?: string }).recovered).toBe('true');
      expect((acts[0] as { target?: string }).target).toBe(target);

      // the heal NEVER settles: the round still owes the target's verdict
      expect(await statusOf(sql, taskId), 'a re-fired referral never settles the round').toBe(IN_REVIEW);

      // idempotent: a later tick must not mint a duplicate row for the same target
      await Bun.sleep(6_000);
      expect(await targetRowCount(sql, taskId, target), 'the round×reviewer uniqueness holds across ticks').toBe(1);
      expect(await statusOf(sql, taskId)).toBe(IN_REVIEW);
    } finally {
      await sql.end();
    }
  });

  test('a recorded target that became the assignee parks — never a self-review mint', async () => {
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const escalator = crypto.randomUUID();
      const target = crypto.randomUUID(); // ALSO the assignee: the owner reassigned mid-handoff
      await seedUser(sql, escalator, `E2E Escalator ${tag}`);
      await seedUser(sql, target, `E2E Target ${tag}`);

      const taskId = `e2e-handoff-park-${tag}`;
      await seedReviewTask(sql, taskId, { reviewers: [escalator], assigneeId: target });
      await seedRow(sql, {
        taskId,
        reviewerId: escalator,
        status: 'ESCALATED',
        referralTargetId: target,
        note: 'escalate to E2E Target for reviewing — wrong domain',
        createdAtSeconds: 1800,
        decidedAtSeconds: 300,
      });

      const end = Date.now() + 20_000;
      while (Date.now() < end && (await statusOf(sql, taskId)) === IN_REVIEW) await Bun.sleep(500);
      expect(
        await statusOf(sql, taskId),
        'the recorded target is now the assignee: the round parks for the owner',
      ).toBe(BLOCKED);
      expect(await targetRowCount(sql, taskId, target), 'no self-review row is minted').toBe(0);
    } finally {
      await sql.end();
    }
  });

  test('a referral owed blocks the matrix — the verdict stands, the round waits', async ({ page }) => {
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const assignee = crypto.randomUUID();
      const escalator = crypto.randomUUID();
      const target = crypto.randomUUID();
      await seedUser(sql, assignee, `E2E Assignee ${tag}`);
      await seedUser(sql, escalator, `E2E Escalator ${tag}`);
      await seedUser(sql, target, `E2E Target ${tag}`);
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for the human verdict').not.toBe('');

      const taskId = `e2e-handoff-owed-${tag}`;
      // the crash shape is 10s old — INSIDE the 60s grace, so the heal cannot fire
      // before the verdict lands; the only live voter is the admin
      await seedReviewTask(sql, taskId, { reviewers: [escalator, adminId], assigneeId: assignee });
      await seedRow(sql, {
        taskId,
        reviewerId: escalator,
        status: 'ESCALATED',
        referralTargetId: target,
        note: 'escalate to E2E Target for reviewing — wrong domain',
        createdAtSeconds: 1800,
        decidedAtSeconds: 10,
      });
      await seedRow(sql, { taskId, reviewerId: adminId, status: 'PENDING', createdAtSeconds: 60 });

      const res = await page.request.post('/rpc/tasks/approve', {
        data: { json: { taskId, body: 'approved out of band' } },
      });
      expect(res.status(), 'the verdict itself is accepted').toBe(200);
      await Bun.sleep(2_000);

      // with the referral owed, the matrix must NOT judge unanimity over the admin alone
      expect(await statusOf(sql, taskId), 'an owed referral keeps the round open').toBe(IN_REVIEW);
      const adminRow = (
        await sql.unsafe('select status from task_reviews where task_id = $1 and round = 1 and reviewer_id = $2', [
          taskId,
          adminId,
        ])
      )[0] as { status?: string } | undefined;
      expect(adminRow?.status, "the reviewer's verdict stands on its own row").toBe('APPROVED');
      expect(await targetRowCount(sql, taskId, target), 'the heal is still inside its grace').toBe(0);
      expect(await statusOf(sql, taskId), 'never silently settled to done').not.toBe(DONE);
    } finally {
      await sql.end();
    }
  });
});
