// STOP-RUN VERB (#229, SPEC): a live run finally offers the human stop path —
// one click settles the run STOPPED over the runner's stream, releases the RUN
// LOCK, and the TASK KEEPS ITS STATUS (a stop is not a verdict). Pinned here:
// the task page's verb fires at a PHONE viewport (MOBILE FIRST) and leaves the
// task Doing; the drawer verb renders only while the run is live; a second
// stop is an idempotent ok; cancel (the RUN LOCK's other half) lands cancelled
// once the run is settled — the exact sequence #223 refused pre-stop.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { TasksPage } from './pages/tasks.page.ts';

/** hold the dispatcher scan off the fresh ready AI task: the tick would claim it
 *  mid-test (create → drawer → manual dispatch crosses the 5s scan) and the run
 *  settles Done before the spec's own click. The MANUAL verb ignores
 *  dispatch_after — only the scan respects it — so the spec's dispatch fires. */
async function holdScan(taskId: string) {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId}`;
  await sql.close();
}

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
        name: `E2E Bot ${tag}`,
        email: `e2e-stop-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Runner',
        environmentId: envId,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  const id = ((await emp.json()) as { json?: { id?: string } }).json?.id;
  expect(id, 'employee create returns the user id').toBeTruthy();
  return { name: `E2E Bot ${tag}`, id: id as string };
}

async function rowTaskIdFromLink(link: ReturnType<import('@playwright/test').Locator['first']>): Promise<string> {
  const href = await link.getAttribute('href');
  expect(href, 'row links to the task page').toBeTruthy();
  return (href as string).split('/').pop() as string;
}

async function rowTaskId(row: ReturnType<TasksPage['rowFor']>): Promise<string> {
  const href = await row.locator('a[href^="/tasks/"]').first().getAttribute('href');
  expect(href, 'row links to the task page').toBeTruthy();
  return (href as string).split('/').pop() as string;
}

/** attach the AI assignee AFTER the dispatch_after hold is set: the task is born
 *  ineligible (no assignee), so the 5s scan can never claim it mid-test */
async function attachAssignee(page: import('@playwright/test').Page, taskId: string, employeeId: string) {
  const res = await page.request.post('/rpc/tasks/update', {
    data: { json: { id: taskId, assigneeId: employeeId } },
  });
  expect(res.status()).toBe(200);
}

// MOBILE FIRST: the task-page stop fires at a phone viewport (390×844, the
// info sheet); the drawer stop below runs at the desktop default.
test.describe('task page stop at a phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('dispatch, one-click stop settles STOPPED, the task keeps its status, re-stop is idempotent, cancel lands', async ({
    page,
  }) => {
    const tasks = new TasksPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const bot = await seedAiEmployee(page, tag);
    const taskTitle = `STOP PG ${tag}`;

    await tasks.navigate('/tasks');
    await tasks.openCreateModal();
    await tasks.fillTaskForm({ title: taskTitle });
    await tasks.saveTask();
    // MOBILE: the list renders CARDS (no table) — the title link opens the page
    const cardLink = page.getByRole('link', { name: taskTitle }).first();
    await expect(cardLink).toBeVisible({ timeout: 15_000 });
    // born ineligible: hold the scan, then attach the AI assignee
    await holdScan(await rowTaskIdFromLink(cardLink));
    await attachAssignee(page, await rowTaskIdFromLink(cardLink), bot.id);
    await cardLink.click();
    await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });

    // at 390px the verbs live in the task info sheet
    const sheetToggle = page.getByTestId('task-info-trigger');
    await expect(sheetToggle).toBeVisible({ timeout: 10_000 });
    await sheetToggle.click();
    const sheet = page.getByRole('dialog', { name: 'Task info' });
    await expect(sheet).toBeVisible();
    const verbs = sheet.getByTestId('task-workflow-actions');
    await verbs.getByTestId('task-verb-dispatch').click();
    await expect(verbs.getByTestId('task-verb-message')).toHaveText('Agent dispatched', { timeout: 15_000 });

    // live run → the stop verb renders (the honest confirm is the hint line)
    const stop = verbs.getByTestId('task-verb-stop');
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await expect(sheet.getByTestId('task-stop-hint')).toBeVisible();
    // ONE click — no second dialog stands between
    await stop.click();
    await expect(verbs.getByTestId('task-verb-message')).toHaveText('Run stopped', { timeout: 15_000 });
    // the verb unmounts with the live state; dispatch stays gone (Doing ≠ ready)
    await expect(stop).toHaveCount(0, { timeout: 15_000 });
    await expect(verbs.getByTestId('task-verb-dispatch')).toHaveCount(0);

    // A STOP IS NOT A VERDICT: the task keeps its status (RUN LOCK released, task untouched)
    await expect(page.getByTestId('task-status-badge')).toHaveText('Doing', { timeout: 15_000 });

    // idempotency: a second stop over the settled run returns ok and lies about
    // nothing (the task id comes from the page we are already on)
    const id = page.url().match(/\/tasks\/([a-z0-9-]+)/i)?.[1] ?? '';
    expect(id).toBeTruthy();
    const res = await page.request.post('/rpc/tasks/stop', { data: { json: { taskId: id } } });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { json: { ok: boolean; stopped: boolean } }).json).toEqual({
      ok: true,
      stopped: false,
    });

    // the run lock's other half: cancel refused over a live run (#223) now lands
    await verbs.getByTestId('task-verb-cancel').click();
    const confirm = verbs.locator('[role="alertdialog"]');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm cancel' }).click();
    await expect(page.getByTestId('task-status-badge')).toHaveText('Cancelled', { timeout: 15_000 });
  });
});

test('drawer stop: renders only while live, settles the run, then cancel completes the flow', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const bot = await seedAiEmployee(page, tag);
  const taskTitle = `STOP DR ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle });
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const taskId = await rowTaskId(row);
  // born ineligible: hold the scan, then attach the AI assignee
  await holdScan(taskId);
  await attachAssignee(page, taskId, bot.id);

  const drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByTestId('drawer-verb-dispatch')).toBeVisible({ timeout: 10_000 });
  await drawer.getByTestId('drawer-verb-dispatch').click();
  await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 15_000 });

  // render parity with the task page: the drawer's own run feed drives the gate
  const stop = drawer.getByTestId('drawer-verb-stop');
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await stop.click();
  // the run card's pill IS the verdict: 'Run stopped' (the composer feedback
  // carries the same words — scope this assert to the run card container)
  await expect(drawer.locator('div.border-default').getByText('Run stopped', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(stop).toHaveCount(0, { timeout: 15_000 });
  await expect(drawer.getByTestId('drawer-verb-dispatch')).toHaveCount(0);

  // the task kept its status through the stop (list row still Doing)
  await tasks.navigate('/tasks');
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 15_000 });

  // cancel over the settled run: the RUN LOCK is released, the flow completes
  const drawer2 = await tasks.openWorkflowDrawer(tasks.rowFor(taskTitle));
  await drawer2.getByTestId('drawer-verb-cancel').click();
  const confirm = drawer2.locator('[role="alertdialog"]');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel task' }).click();
  await expect(drawer2.getByText('Task cancelled')).toBeVisible({ timeout: 15_000 });
});
