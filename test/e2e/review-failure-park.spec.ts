// E2E (#199): a review round whose reviewer turn dies mid-flight parks on the owner,
// and the owner's unblock re-fires the parked reviewer. The failure is injected at
// the SQL level because the fake runner cannot fail per-test: a RUNNING review run is
// inserted BEFORE submit (fresh, so no sweep can reap it pre-submit) and backdated
// past the reaper cutoff only AFTER the round opens (#375) — the sequential-turn law
// then suppresses the real mint while it is RUNNING, and the REAL reaper (run timeout
// + grace < 2h) reaps it mid-round. That is the exact production class: a reviewer
// host dies with the turn live, the reaper fires, the round must park — never the
// work ladder's todo-flip, which would yank an in-review task out of its open round.
// The second half proves the recovery loop: unblock (status -> in-review) re-fires
// the reviewer's turn through the unblock-resume path; the verdict-less bound
// (#276: per-round) re-dispatches ONCE with the CORRECTION block and the corrected
// fake script settles the round — the loop recovers without a second park.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { TasksPage } from './pages/tasks.page.ts';

async function seedAiEmployee(page: import('@playwright/test').Page, tag: string): Promise<string> {
  const env = await page.request.post('/rpc/environments/create', {
    data: { json: { name: `E2E Env ${tag}`, host: '127.0.0.1', port: '22', username: 'e2e' } },
  });
  expect(env.status()).toBe(200);
  const envId = ((await env.json()) as { json?: { id?: string } }).json?.id;
  expect(envId).toBeTruthy();
  const emp = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `E2E Reviewer ${tag}`,
        email: `e2e-reap-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Reviewer',
        environmentId: envId,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  return `E2E Reviewer ${tag}`;
}

/**
 * #375: TWO flake classes lived in this file, both from seeding/reaping order.
 *
 * (1) The submit's In-review state is NOT observable on the client: the round opens
 * server-side and the reaper's 5s sweep can park it before the client's first
 * post-submit fetch lands — the badge legitimately goes Doing → Blocked and never
 * renders "In review" (the old `toHaveText('In review')` lost that race in 2 gate
 * runs). The contract is the ROUND OPEN, not a transient render: pin it in the DB —
 * a PENDING review row appears only after a WON in-review flip (#394/#292) — and
 * assert the DELTA against the pre-click baseline, never an absolute row count.
 *
 * (2) The injected review turn must be seeded FRESH and backdated only AFTER the
 * round opened: a 2h-old RUNNING row is past the reaper cutoff from the millisecond
 * it commits, so a 5s tick landing before the submit click reaps it while the task is
 * still Doing and bounces it to To do (the verb vanishes; the submit never runs).
 */
async function pendingReviewRows(taskId: string): Promise<number> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      select count(*)::int as n from task_reviews where task_id = ${taskId} and status = 'PENDING'
    `;
    return Number(rows[0]!.n);
  } finally {
    await sql.close();
  }
}

/** poll the round-open delta: THIS submit adds exactly one PENDING row to the baseline. */
async function expectRoundOpened(taskId: string, baseline: number): Promise<void> {
  await expect
    .poll(() => pendingReviewRows(taskId), { timeout: 15_000, intervals: [250, 250, 500, 1000] })
    .toBe(baseline + 1);
}

/** backdate the seeded RUNNING turn past the reaper cutoff — only once the round is
 *  open, so the reap (and its park) is strictly post-round-open. */
async function backdateReviewRun(runId: string): Promise<void> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      update task_runs set started_at = now() - interval '2 hours'
      where id = ${runId} and status = 'RUNNING'
      returning id
    `;
    // the seeded turn must still be live at the backdate: a settled row would mean the
    // submit's own dispatch raced the seed and the park this spec waits for cannot land
    expect(rows.length).toBe(1);
  } finally {
    await sql.close();
  }
}

test('reaped review turn parks the round; owner unblock re-fires the reviewer (#199)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `REAP PARK ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await page.getByText('Add reviewers…').click();
  await page.getByRole('option', { name: botName }).first().click();
  await page.keyboard.press('Escape');
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  // human assignee: Doing FIRST — a live run locks status edits, so the stale
  // review run must be inserted only after the task reached a working status
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  // inject the RUNNING review turn (the exact reaped-mid-turn shape). Seeded FRESH and
  // backdated only after the round opens (#375) — stale at insert, a sweep tick could
  // reap it while the task is still Doing and bounce it to To do before the submit.
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  let injectedTaskId = '';
  let injectedRunId = '';
  try {
    const inserted = await sql`
      insert into task_messages (id, task_id, author_id, body, created_at)
      select gen_random_uuid()::text, t.id, u.id, '[e2e] stale review turn', now()
      from tasks t, "user" u
      where t.title = ${taskTitle} and u.name = ${botName}
      returning id, task_id
    `;
    expect(inserted.length).toBe(1);
    const messageId = inserted[0]!.id as string;
    injectedTaskId = inserted[0]!.task_id as string;
    expect(injectedTaskId).toBeTruthy();
    const run = await sql`
      insert into task_runs (id, message_id, employee_id, status, output, started_at)
      select gen_random_uuid()::text, m.id, u.id, 'RUNNING', '[e2e] reviewer host died mid-turn', now()
      from task_messages m, "user" u
      where m.id = ${messageId} and u.name = ${botName}
      returning id
    `;
    expect(run.length).toBe(1);
    injectedRunId = run[0]!.id as string;
  } finally {
    await sql.close();
  }

  // submit opens the round: the RUNNING synthetic turn suppresses the real mint
  await tasks.rowFor(taskTitle).getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-submit')).toBeVisible({ timeout: 10_000 });
  const roundsBefore = await pendingReviewRows(injectedTaskId);
  const submitted = page.waitForResponse((r) => r.url().includes('/rpc/tasks/submit'));
  await verbs.getByTestId('task-verb-submit').click();
  // the handler awaits its post-commit review dispatch before responding: waiting for the
  // response means the mint attempt is over, so the backdate cannot un-suppress a mint
  await submitted;
  await expectRoundOpened(injectedTaskId, roundsBefore);
  await backdateReviewRun(injectedRunId);

  // the reaper reaps the stale turn (next 5s tick) and parks the round on the owner
  await expect(page.getByTestId('task-status-badge')).toHaveText('Blocked', { timeout: 30_000 });

  // owner resolution: unblock re-fires the parked reviewer via the unblock-resume path.
  // The re-fired turn settles verdict-less (default review script emits no envelope);
  // the per-round bound (#276) then re-dispatches ONCE with the CORRECTION block and
  // the corrected script settles the round — one park cycle, never a wedge.
  await tasks.navigate('/tasks');
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'In review' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Done', { timeout: 45_000 });

  // the only park on this path is the reaper's infra park; the corrected re-dispatch
  // settled the round instead of parking again (decision parks are unit-pinned).
  // The predicate names the REAPER's cause: a submit-time dispatch-failure park is the
  // same shape otherwise (#375) and would make this spec green on the wrong parker.
  const sql2 = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const notes = await sql2`
      select
        (select count(*)::int from task_messages
          where task_id = ${injectedTaskId}
            and body like 'review parked — review turn timed out — reaped after %') as reaped,
        (select status from task_runs where id = ${injectedRunId}) as run_status
    `;
    expect(Number(notes[0]!.reaped)).toBe(1);
    expect(notes[0]!.run_status).toBe('FAILED');
  } finally {
    await sql2.close();
  }
});

// E2E (#211): the reaper's infra-class park now carries a RE-ARM ledger — and when the
// ladder is due (seeded into the past), the dispatcher tick's re-arm scan re-runs the
// unblock arm: the parked reviewer's turn MINTS again without any owner action. The
// re-minted turn's verdict-less settle then takes the per-round corrected re-dispatch
// (#276) and the corrected script settles the round — the ladder recovered the round
// end-to-end with no owner move. Together: a parked round whose machine resume failed
// is never a silent terminal state; the machine re-fires within one tick of the ladder
// coming due.
test('infra park re-arms on the ladder and re-mints the reviewer turn (#211)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `REARM ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await page.getByText('Add reviewers…').click();
  await page.getByRole('option', { name: botName }).first().click();
  await page.keyboard.press('Escape');
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  // inject the RUNNING review turn — the reaper's park is infra-class (#211). Seeded
  // FRESH and backdated after the round opens (#375), same law as the test above.
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  let taskId = '';
  let runId = '';
  try {
    const inserted = await sql`
      insert into task_messages (id, task_id, author_id, body, created_at)
      select gen_random_uuid()::text, t.id, u.id, '[e2e] stale review turn', now()
      from tasks t, "user" u
      where t.title = ${taskTitle} and u.name = ${botName}
      returning id, task_id
    `;
    expect(inserted.length).toBe(1);
    taskId = inserted[0]!.task_id as string;
    expect(taskId).toBeTruthy();
    const run = await sql`
      insert into task_runs (id, message_id, employee_id, status, output, started_at)
      select gen_random_uuid()::text, m.id, u.id, 'RUNNING', '[e2e] reviewer host died mid-turn', now()
      from task_messages m, "user" u
      where m.id = ${inserted[0]!.id} and u.name = ${botName}
      returning id
    `;
    expect(run.length).toBe(1);
    runId = run[0]!.id as string;
  } finally {
    await sql.close();
  }

  await tasks.rowFor(taskTitle).getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-submit')).toBeVisible({ timeout: 10_000 });
  const roundsBefore = await pendingReviewRows(taskId);
  const submitted = page.waitForResponse((r) => r.url().includes('/rpc/tasks/submit'));
  await verbs.getByTestId('task-verb-submit').click();
  await submitted;
  await expectRoundOpened(taskId, roundsBefore);
  await backdateReviewRun(runId);

  // the reaper parks the round — the park write carries the re-arm ledger
  await expect(page.getByTestId('task-status-badge')).toHaveText('Blocked', { timeout: 30_000 });
  const sql3 = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const ledger = await sql3`
      select park_rearm_attempts::int as attempts, park_rearm_after is not null as scheduled
      from tasks where id = ${taskId}
    `;
    expect(Number(ledger[0]!.attempts)).toBe(1);
    expect(ledger[0]!.scheduled).toBe(true);

    // the PARKER is the reaper — a submit-time dispatch-failure park carries the same
    // ledger shape (#375), so name the cause instead of matching any park note
    const parked = await sql3`
      select count(*)::int as n from task_messages
      where task_id = ${taskId} and body like 'review parked — review turn timed out — reaped after %'
    `;
    expect(Number(parked[0]!.n)).toBe(1);

    // pull the ladder due: the NEXT tick re-arms — restore + re-mint, no owner action
    await sql3`update tasks set park_rearm_after = now() - interval '1 second' where id = ${taskId}`;
    const runsBefore = await sql3`
      select count(*)::int as n from task_runs r
      join task_messages m on m.id = r.message_id
      where m.task_id = ${taskId}
    `;
    const before = Number(runsBefore[0]!.n);
    await expect
      .poll(
        async () => {
          const r = await sql3`
            select count(*)::int as n from task_runs r
            join task_messages m on m.id = r.message_id
            where m.task_id = ${taskId}
          `;
          return Number(r[0]!.n);
        },
        { timeout: 45_000, intervals: [2_000, 5_000, 5_000, 10_000] },
      )
      .toBeGreaterThanOrEqual(before + 1); // the re-arm re-minted the reviewer's turn

    // the re-fired turn settles verdict-less; the per-round bound's corrected
    // re-dispatch (#276) then carries the CORRECTION block and the corrected script
    // settles the round — the ladder recovered it, no owner action, no re-park
    await expect(page.getByTestId('task-status-badge')).toHaveText('Done', { timeout: 45_000 });
    const ledger2 = await sql3`
      select park_rearm_attempts::int as attempts, park_rearm_after as after from tasks where id = ${taskId}
    `;
    // the ledger keeps the ladder's history (attempts survive the resume); a stale
    // park_rearm_after is INERT — the scan keys on BLOCKED, and the round is done
    expect(Number(ledger2[0]!.attempts)).toBe(1);
  } finally {
    await sql3.close();
  }
});
