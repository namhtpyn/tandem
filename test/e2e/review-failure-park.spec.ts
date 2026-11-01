// E2E (#199): a review round whose reviewer turn dies mid-flight parks on the owner,
// and the owner's unblock re-fires the parked reviewer. The failure is injected at
// the SQL level because the fake runner cannot fail per-test: a stale RUNNING review
// run (started 2h ago) is inserted BEFORE submit — the sequential-turn law then
// suppresses the real mint while it is RUNNING, and the REAL reaper (run timeout +
// grace < 2h) reaps it mid-round. That is the exact production class: a reviewer
// host dies with the turn live, the reaper fires, the round must park — never the
// work ladder's todo-flip, which would yank an in-review task out of its open round.
// The second half proves the recovery loop: unblock (status -> in-review) re-fires
// the reviewer's turn through the unblock-resume path; the verdict-less bound
// (default review script emits no envelope, 2+ runs this round) re-parks it.
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

  // inject the stale RUNNING review turn (the exact reaped-mid-turn shape)
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  let injectedTaskId = '';
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
    await sql`
      insert into task_runs (id, message_id, employee_id, status, output, started_at)
      select gen_random_uuid()::text, m.id, u.id, 'RUNNING', '[e2e] reviewer host died mid-turn', now() - interval '2 hours'
      from task_messages m, "user" u
      where m.id = ${messageId} and u.name = ${botName}
    `;
  } finally {
    await sql.close();
  }

  // submit opens the round: the RUNNING synthetic turn suppresses the real mint
  await tasks.rowFor(taskTitle).getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-submit')).toBeVisible({ timeout: 10_000 });
  await verbs.getByTestId('task-verb-submit').click();
  await expect(page.getByTestId('task-status-badge')).toHaveText('In review', { timeout: 15_000 });

  // the reaper reaps the stale turn (next 5s tick) and parks the round on the owner
  await expect(page.getByTestId('task-status-badge')).toHaveText('Blocked', { timeout: 30_000 });

  // owner resolution: unblock re-fires the parked reviewer via the unblock-resume path
  await tasks.navigate('/tasks');
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'In review' }).click();
  // the re-fired turn settles verdict-less (default review script emits no envelope)
  // and the round's 2-run bound re-parks it — the loop is recoverable, never a wedge
  await expect(tasks.rowFor(taskTitle)).toContainText('Blocked', { timeout: 30_000 });

  // both park cycles left their notes in the activity store (STATUS rows are
  // pipeline chatter — deliberately excluded from the thread timeline)
  const sql2 = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const notes = await sql2`
      select count(*)::int as n from task_messages
      where task_id = ${injectedTaskId} and body like 'review parked —%'
    `;
    expect(Number(notes[0]!.n)).toBe(2);
  } finally {
    await sql2.close();
  }
});
