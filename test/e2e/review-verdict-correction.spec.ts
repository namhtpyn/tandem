// E2E (#276): the verdict-less settle path re-dispatches ONCE with a CORRECTION block
// frozen into the reviewer's brief — and a reviewer that then emits a conforming
// envelope settles the round instead of parking. Turn 1: the default review script
// (prose + legacy RESULT line, no envelope) settles verdict-less with 1 run this
// round -> the corrected re-dispatch mints with the CORRECTION block (run 1's prompt
// must NOT carry it — first-turn briefs never do) -> the corrected fake script emits
// the approved envelope -> the round settles DONE, never Blocked.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { TasksPage } from './pages/tasks.page.ts';

const CORRECTION_MARKER = 'CORRECTION (verdict-less re-dispatch)';

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
        email: `e2e-vcorr-${tag}@tandem.local`,
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

test('verdict-less re-dispatch carries the correction block and settles on the corrected envelope (#276)', async ({
  page,
}) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `VCORR ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await page.getByText('Add reviewers…').click();
  await page.getByRole('option', { name: botName }).first().click();
  await page.keyboard.press('Escape');
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  // human assignee: the submit-for-review verb needs a working status
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  await tasks.rowFor(taskTitle).getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-submit')).toBeVisible({ timeout: 10_000 });
  await verbs.getByTestId('task-verb-submit').click();
  await expect(page.getByTestId('task-status-badge')).toHaveText('In review', { timeout: 15_000 });

  // turn 1 verdict-less -> corrected re-dispatch -> conforming approved envelope
  // -> round settles (no park anywhere in between)
  await expect(page.getByTestId('task-status-badge')).toHaveText('Done', { timeout: 60_000 });

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const runs = await sql`
      select r.prompt, r.output, r.started_at
      from task_runs r
      join task_messages m on m.id = r.message_id
      join "user" u on u.id = m.author_id
      where u.name = ${botName}
      order by r.started_at asc
    `;
    expect(runs.length).toBe(2);
    const first = runs[0]!;
    const second = runs[1]!;
    // first-turn brief NEVER carries the block; the re-dispatch brief ALWAYS does
    expect(String(first.prompt)).not.toContain(CORRECTION_MARKER);
    expect(String(second.prompt)).toContain(CORRECTION_MARKER);
    // turn 1 was verdict-less prose, turn 2 emitted the conforming envelope
    expect(String(first.output)).toContain('RESULT: task complete as requested');
    expect(String(second.output)).toContain('"kind": "approved"');

    // and the loop never parked the round
    const parks = await sql`
      select count(*)::int as n
      from task_messages m
      join tasks t on t.id = m.task_id
      where t.title = ${taskTitle} and m.body like 'review parked —%'
    `;
    expect(Number(parks[0]!.n)).toBe(0);
  } finally {
    await sql.close();
  }
});
