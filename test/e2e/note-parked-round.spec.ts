// E2E (#443): a send on a PARKED task is an egress from a review park. Before the fix the
// dispatch flip bounced the task to to-do and left the round behind: the PENDING reviewer
// row sat on a paused task no sweep can reach (the stalled-review and lost-settle scans
// require review-flow ownership — in_review, or a gating block whose origin resolves
// there), so the parked reviewer never decided, its verdict was discarded silently, and
// #427 reset the park's re-arm ladder in the same statement. The contract now (SPEC
// COMPOSER LAW, NOTE-EGRESS ROUND TEARDOWN): the SAME transaction that lands the flip
// supersedes every PENDING row and cancels the approval obligation, so the task returns to
// work on a clean slate and the next submit opens the next round over no live rows.
//
// Seeded at the SQL layer: a real park needs a failed review turn, which the fake runner
// cannot fail per-test — but the note verb, its transaction, the flip and the teardown are
// all the REAL server code. The "next submit opens the next round cleanly" half is pinned
// by its mechanism (zero PENDING rows after the egress, so round N+1 cannot inherit a live
// row); the submit path itself is covered by the review-flow specs.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

type Sql = SQL;

async function seedAiEmployee(page: import('@playwright/test').Page, tag: string): Promise<void> {
  const env = await page.request.post('/rpc/environments/create', {
    data: { json: { name: `E2E Note Env ${tag}`, host: '127.0.0.1', port: '22', username: 'e2e' } },
  });
  expect(env.status()).toBe(200);
  const envId = ((await env.json()) as { json?: { id?: string } }).json?.id;
  expect(envId).toBeTruthy();
  const emp = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `E2E Note Bot ${tag}`,
        email: `e2e-note-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Worker',
        environmentId: envId,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
}

async function userIdByEmail(sql: Sql, email: string): Promise<string> {
  const rows = (await sql.unsafe(`select id from "user" where email = $1`, [email])) as Array<{ id: string }>;
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

test('a note on a parked task tears the parked round down and returns the task to work (#443)', async ({ page }) => {
  test.setTimeout(90_000);
  const tag = Date.now().toString(36).slice(-6);
  await seedAiEmployee(page, tag);
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const assigneeId = await userIdByEmail(sql, `e2e-note-${tag}@tandem.local`);
    const created = await page.request.post('/rpc/tasks/create', {
      data: { json: { title: `NOTE PARK ${tag}`, assigneeId } },
    });
    expect(created.status()).toBe(200);
    const taskId = ((await created.json()) as { json?: { id?: string } }).json?.id;
    expect(taskId).toBeTruthy();

    // the parked shape: BLOCKED with the park's recorded in-review home, the round's
    // reviewer row still PENDING, and the approval obligation the parked turn owns.
    // updated_at is truncated to MILLISECONDS: the flip's CAS arbitrates on the stamp this
    // request read (a JS Date, ms precision), and a microsecond-precision SQL now() could
    // never equal it — the send would land thread-only and look like a lost race.
    await sql.unsafe(
      `update tasks set status = $2, park_from_status = $3, pre_block_status = null,
         park_rearm_attempts = 2, park_rearm_after = now() + interval '30 minutes',
         updated_at = date_trunc('milliseconds', now())
       where id = $1`,
      [taskId, BLOCKED, IN_REVIEW],
    );
    await sql.unsafe(
      `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at)
       values ($1, $2, $3, 1, 'PENDING', 'ai', now())`,
      [`rev-${tag}`, taskId, assigneeId],
    );
    await sql.unsafe(
      `insert into task_obligations (id, task_id, employee_id, role, status, created_at)
       values ($1, $2, $3, 'APPROVAL', 'PENDING', now())`,
      [`obl-${tag}`, taskId, assigneeId],
    );

    // the send: the composer's dispatch path (AI assignee, non-terminal non-in-review
    // category) — REAL verb, REAL transaction
    const noted = await page.request.post('/rpc/tasks/note', {
      data: { json: { taskId, body: 'go ahead, take another pass' } },
    });
    expect(noted.status()).toBe(200);

    const state = (await sql.unsafe(
      `select s.category, t.park_from_status, t.pre_block_status, t.park_rearm_attempts,
         (select count(*)::int from task_reviews r where r.task_id = t.id and r.status = 'PENDING') as pending,
         (select count(*)::int from task_reviews r where r.task_id = t.id and r.status = 'SUPERSEDED' and r.decided_at is not null) as superseded,
         (select count(*)::int from task_obligations o where o.task_id = t.id and o.role = 'APPROVAL' and o.status = 'PENDING') as pending_obligations,
         (select count(*)::int from task_obligations o where o.task_id = t.id and o.role = 'APPROVAL' and o.status = 'CANCELLED') as cancelled_obligations
       from tasks t join task_statuses s on s.id = t.status where t.id = $1`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    const row = state[0]!;
    // the flip landed: the task is back on the work surface (the dispatcher may already
    // have claimed it to a working status — the CATEGORY is the contract, not the id)
    expect(['ready', 'working']).toContain(row.category);
    // the egress exhausts the block memory AND the parked round's ladder (#427)
    expect(row.park_from_status).toBeNull();
    expect(row.pre_block_status).toBeNull();
    expect(row.park_rearm_attempts).toBe(0);
    // the round it left is resolved, not stranded
    expect(row.pending).toBe(0);
    expect(row.superseded).toBe(1);
    expect(row.pending_obligations).toBe(0);
    expect(row.cancelled_obligations).toBe(1);

    // the thread states what happened — the settle copy would be a lie on a to-do flip,
    // and the payload carries the machine-readable cause for the audit trail
    const closes = (await sql.unsafe(
      `select m.body, (select a.payload->>'reason' from task_message_activities a where a.message_id = m.id) as reason
       from task_messages m where m.task_id = $1 and m.body like 'review rounds closed%'`,
      [taskId],
    )) as Array<{ body: string; reason: string | null }>;
    expect(closes).toHaveLength(1);
    expect(closes[0]!.body).toContain('the note sent the task back to work');
    expect(closes[0]!.reason).toBe('egress');
  } finally {
    await sql.close();
  }
});
