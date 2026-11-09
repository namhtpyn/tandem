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

// E2E (#370/#371): a reviewer deleted while their review TURN is in flight must not
// leave a zombie run that parks the round it no longer owns, and the sequential queue
// must advance to the next AI reviewer. Submit mints the first AI reviewer's turn
// (one in flight per task); deleting that reviewer mid-turn settles their run STOPPED
// and re-mints the next pending AI reviewer — the round finishes instead of wedging.
test('reviewer deleted mid-turn: the zombie turn never parks; the next reviewer is minted (#370/#371)', async ({
  page,
}) => {
  const tag = Date.now().toString(36).slice(-6);

  async function seedAiReviewer(label: string): Promise<{ id: string; name: string }> {
    const envRes = await post(page, 'environments/create', {
      name: `E2E Env ${tag} ${label}`,
      host: '127.0.0.1',
      port: '22',
      username: 'e2e',
    });
    expect(envRes.status()).toBe(200);
    const envId = (await envRes.json()).json.id as string;
    const empRes = await post(page, 'employees/create', {
      name: `AI ${label} ${tag}`,
      email: `e2e-ai-${label}-${tag}@tandem.local`,
      kind: 'ai',
      title: 'Reviewer',
      environmentId: envId,
      executable: 'hermes acp',
    });
    expect(empRes.status()).toBe(200);
    return (await empRes.json()).json as { id: string; name: string };
  }

  const ai1 = await seedAiReviewer('one');
  const ai2 = await seedAiReviewer('two');

  const statusesRes = await post(page, 'statuses/list', null);
  const statuses = ((await statusesRes.json()).json ?? []) as { id: string; category: string }[];
  const working = statuses.find((s) => s.category === 'working');
  const inReview = statuses.find((s) => s.category === 'in_review');
  const done = statuses.find((s) => s.category === 'done');
  expect(working && inReview && done).toBeTruthy();

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const admins = await sql`select id from "user" where role = 'ADMIN' order by created_at asc limit 1`;
    const adminId = admins[0]!.id as string;

    const created = await post(page, 'tasks/create', {
      title: `Reviewer mid-turn removal ${tag}`,
      assigneeId: adminId,
      reviewers: [ai1.id, ai2.id],
    });
    expect(created.status()).toBe(200);
    const taskId = (await created.json()).json.id as string;
    expect((await post(page, 'tasks/setStatus', { id: taskId, status: working!.id })).status()).toBe(200);
    const submitted = await post(page, 'tasks/submit', { taskId, body: 'ready for review' });
    expect(submitted.status()).toBe(200);
    expect((await submitted.json()).json.status).toBe(inReview!.id);

    // the fake review turn stays RUNNING for ~5s — wait for the row, then delete the
    // reviewer INSIDE that window (the exact prod shape: a host dies mid-turn)
    let runId = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !runId) {
      const rows = (await sql`
        select r.id from task_runs r
        join task_messages m on m.id = r.message_id
        where m.task_id = ${taskId} and r.employee_id = ${ai1.id} and r.status = 'RUNNING'
        limit 1
      `) as Array<{ id: string }>;
      if (rows.length > 0) runId = rows[0]!.id;
      else await page.waitForTimeout(100);
    }
    expect(runId).toBeTruthy();

    expect((await post(page, 'employees/remove', { id: ai1.id })).status()).toBe(200);

    // the in-flight turn is settled STOPPED by the removal (the turn's own settle
    // then skips every side effect — no zombie park)
    await expect
      .poll(
        async () => {
          const rows = (await sql`select status from task_runs where id = ${runId}`) as Array<{ status: string }>;
          return rows[0]?.status;
        },
        { timeout: 15_000 },
      )
      .toBe('STOPPED');

    // the round advances: the second AI reviewer's turn is minted and (fake runner:
    // verdict-less -> corrected retry) settles the round to done
    await expect
      .poll(
        async () => {
          const rows = (await sql`select status from tasks where id = ${taskId}`) as Array<{ status: string }>;
          return rows[0]?.status;
        },
        { timeout: 60_000 },
      )
      .toBe(done!.id);

    const ai2Runs = (await sql`
      select count(*)::int as n from task_runs r
      join task_messages m on m.id = r.message_id
      where m.task_id = ${taskId} and r.employee_id = ${ai2.id}
    `) as Array<{ n: number }>;
    expect(Number(ai2Runs[0]!.n)).toBeGreaterThan(0);

    const parks = (await sql`
      select count(*)::int as n from task_messages
      where task_id = ${taskId} and body like 'review parked —%'
    `) as Array<{ n: number }>;
    expect(Number(parks[0]!.n)).toBe(0);
  } finally {
    await sql.close();
  }
});

// E2E (#370 r2): the removal must neutralize only REVIEW turns. Deleting an AI
// ASSIGNEE whose work run is in flight must leave that work run to settle normally —
// its bounce arm returns the (now assignee-less) doing task to todo. A blanket stop
// would skip the bounce and strand the task in doing with no assignee and no run.
test('removal leaves a departing assignee’s WORK run to its normal bounce (#370)', async ({ page }) => {
  const tag = Date.now().toString(36).slice(-6);
  const envRes = await post(page, 'environments/create', {
    name: `E2E Work Env ${tag}`,
    host: '127.0.0.1',
    port: '22',
    username: 'e2e',
  });
  expect(envRes.status()).toBe(200);
  const envId = (await envRes.json()).json.id as string;
  const empRes = await post(page, 'employees/create', {
    name: `AI Worker ${tag}`,
    email: `e2e-worker-${tag}@tandem.local`,
    kind: 'ai',
    title: 'Worker',
    environmentId: envId,
    executable: 'hermes acp',
  });
  expect(empRes.status()).toBe(200);
  const worker = (await empRes.json()).json as { id: string };

  const statusesRes = await post(page, 'statuses/list', null);
  const statuses = ((await statusesRes.json()).json ?? []) as { id: string; category: string }[];
  const todo = statuses.find((s) => s.category === 'ready');
  expect(todo).toBeTruthy();

  const created = await post(page, 'tasks/create', {
    title: `Work run removal ${tag}`,
    assigneeId: worker.id,
  });
  expect(created.status()).toBe(200);
  const taskId = (await created.json()).json.id as string;
  // manual dispatch starts the fake work turn deterministically (ready + AI assignee)
  const dispatched = await post(page, 'tasks/dispatch', { taskId });
  expect(dispatched.status()).toBe(200);

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    let runId = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !runId) {
      const rows = (await sql`
        select r.id from task_runs r
        join task_messages m on m.id = r.message_id
        where m.task_id = ${taskId} and r.employee_id = ${worker.id} and r.status = 'RUNNING'
        limit 1
      `) as Array<{ id: string }>;
      if (rows.length > 0) runId = rows[0]!.id;
      else await page.waitForTimeout(100);
    }
    expect(runId).toBeTruthy();

    expect((await post(page, 'employees/remove', { id: worker.id })).status()).toBe(200);

    // the work run is NOT stopped by the removal — it finishes and its bounce returns
    // the assignee-less task to todo
    await expect
      .poll(
        async () => {
          const rows = (await sql`select status from task_runs where id = ${runId}`) as Array<{ status: string }>;
          return rows[0]?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('DONE');
    await expect
      .poll(
        async () => {
          const rows = (await sql`select status from tasks where id = ${taskId}`) as Array<{ status: string }>;
          return rows[0]?.status;
        },
        { timeout: 30_000 },
      )
      .toBe(todo!.id);
  } finally {
    await sql.close();
  }
});
