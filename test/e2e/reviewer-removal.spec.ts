// E2E (#365): a reviewer deleted while a review round is open used to leave a
// PENDING task_reviews row with reviewer_id NULL (FK `on delete set null`) — no
// verdict could ever land, so the round never settled and the task sat in review
// forever. The round now settles by the normal matrix without the impossible
// verdict; the task returns to the assignee and a resubmit completes it exactly as
// if no reviewer were set (REVIEWER EXISTENCE's zero-survivor contract).
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

async function post(page: import('@playwright/test').Page, path: string, json: unknown) {
  return page.request.post(`/rpc/${path}`, { data: { json } });
}

test('reviewer deleted mid-round: the round settles instead of wedging (#365)', async ({ page }) => {
  const tag = Date.now().toString(36);
  // a HUMAN reviewer holds the round open with no run — deterministic (no fake-runner turn)
  const revRes = await post(page, 'employees/create', {
    name: `Rv ${tag}`,
    email: `e2e-removed-${tag}-${Math.random().toString(36).slice(2, 8)}@tandem.local`,
    kind: 'human',
    title: 'Reviewer',
  });
  expect(revRes.status()).toBe(200);
  const reviewer = (await revRes.json()).json as { id: string };

  const statusesRes = await post(page, 'statuses/list', null);
  const statuses = ((await statusesRes.json()).json ?? []) as { id: string; category: string }[];
  const ready = statuses.find((s) => s.category === 'ready');
  const working = statuses.find((s) => s.category === 'working');
  const inReview = statuses.find((s) => s.category === 'in_review');
  const done = statuses.find((s) => s.category === 'done');
  expect(ready && working && inReview && done).toBeTruthy();

  // the signed-in admin is the assignee (submit requires assignee == author)
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  let adminId = '';
  try {
    const admins = await sql`select id from "user" where role = 'ADMIN' order by created_at asc limit 1`;
    adminId = admins[0]!.id as string;
    expect(adminId).toBeTruthy();
  } finally {
    await sql.close();
  }

  const created = await post(page, 'tasks/create', {
    title: `Reviewer removal ${tag}`,
    assigneeId: adminId,
    reviewers: [reviewer.id],
  });
  expect(created.status()).toBe(200);
  const taskId = (await created.json()).json.id as string;
  expect((await post(page, 'tasks/setStatus', { id: taskId, status: working!.id })).status()).toBe(200);
  const submitted = await post(page, 'tasks/submit', { taskId, body: 'ready for review' });
  expect(submitted.status()).toBe(200);
  expect((await submitted.json()).json.status).toBe(inReview!.id);

  // the reviewer leaves the company mid-round — the round must NOT wedge on the
  // void pending row the FK leaves behind
  expect((await post(page, 'employees/remove', { id: reviewer.id })).status()).toBe(200);

  const sql2 = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql2`select status from tasks where id = ${taskId}`;
    // no live voter remained: the matrix returned the task to the assignee
    expect(rows[0]!.status).toBe(ready!.id);
    const reviews = await sql2`select status, reviewer_id from task_reviews where task_id = ${taskId}`;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe('SUPERSEDED');
    expect(reviews[0]!.reviewer_id).toBeNull();
    const obligations = (await sql2`
      select status, count(*)::int as n from task_obligations
      where task_id = ${taskId} and role = 'APPROVAL'
      group by status
    `) as Array<{ status: string; n: number }>;
    // the departing reviewer's row is DROPPED whole (a cancelled row would read as
    // a dead round to the approver tally) — no obligation outlives its holder
    expect(obligations).toHaveLength(0);
  } finally {
    await sql2.close();
  }

  // resubmit: the ghost reviewer drops (REVIEWER EXISTENCE), zero survivors ->
  // the task completes exactly as if no reviewer had been set
  expect((await post(page, 'tasks/setStatus', { id: taskId, status: working!.id })).status()).toBe(200);
  const resubmitted = await post(page, 'tasks/submit', { taskId, body: 'resubmit' });
  expect(resubmitted.status()).toBe(200);
  expect((await resubmitted.json()).json.status).toBe(done!.id);
});
