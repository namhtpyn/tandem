// RUN LOCK on every status surface (#264, SPEC: "rejected server-side and
// disabled in the UI") + COMPOSER HINT LAW (#265). The detail page always
// honored the lock; the list select, the Move-to menus and the board drag did
// not — a move on a running task fired the doomed mutation and snapped back
// with the lock error. Pinned here: the paged row carries the server's
// live-run bit and every surface folds it (select disabled + lock affordance,
// drag off, kebab Move-to disabled with the hint, drawer hint reading
// steering); the composer hint/aria promise dispatch exactly where the server
// dispatches (any non-terminal, non-in-review AI assignee — not just ready).
// Runs are seeded straight into the e2e db (the fake runner settles in ~200ms —
// too fast to observe a live lock through a real dispatch).
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

async function seedAiEmployee(
  page: import('@playwright/test').Page,
  tag: string,
): Promise<{ name: string; id: string }> {
  const env = await page.request.post('/rpc/environments/create', {
    data: { json: { name: `E2E Env ${tag}`, host: '127.0.0.1', port: '22', username: 'e2e' } },
  });
  expect(env.status()).toBe(200);
  const emp = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `E2E Bot ${tag}`,
        email: `e2e-run-lock-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Runner',
        environmentId: ((await env.json()) as { json?: { id?: string } }).json?.id,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  const id = ((await emp.json()) as { json?: { id?: string } }).json?.id;
  expect(id, 'employee create returns the user id').toBeTruthy();
  return { name: `E2E Bot ${tag}`, id: id as string };
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

async function seedRunningRun(taskId: string) {
  // one message per run turn (the thread's message→run relation is 1:1); ids are
  // explicit — schema defaults are app-side (drizzle), not SQL DEFAULTs
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const msgId = crypto.randomUUID();
  await sql`insert into task_messages (id, task_id, body, created_at) values (${msgId}, ${taskId}, 'run-lock probe turn', now())`;
  await sql`insert into task_runs (id, message_id, status, output, started_at)
    values (${crypto.randomUUID()}, ${msgId}, 'RUNNING', '', now())`;
  await sql.close();
}

/** hold the dispatcher scan off a fresh ready AI task (the 5s tick would claim
 *  it mid-test; the manual verb ignores dispatch_after — only the scan does) */
async function holdScan(taskId: string) {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId}`;
  await sql.close();
}

async function createRow(page: import('@playwright/test').Page, tasks: TasksPage, title: string, assignee?: string) {
  await tasks.createTask({ title, ...(assignee ? { assignee } : {}) });
  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const href = await row.locator('a[href^="/tasks/"]').first().getAttribute('href');
  expect(href, 'row links to the task page').toBeTruthy();
  return { row, taskId: (href as string).split('/').pop() as string };
}

test('run lock: list select, board drag and Move-to all disable on a live run (#264)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const title = `RUNLOCK ${tag}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  const { taskId } = await createRow(page, tasks, title);
  await seedRunningRun(taskId);

  // fresh load: the paged row carries the lock bit
  await page.goto('/tasks');
  await waitForHydration(page);
  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });

  // list select: disabled with the honest accessible name (the lock affordance
  // — icon + hint — rides the same state); Auto-assign is an assignee edit, the
  // same lock folds it (r1: the server now refuses it too)
  const select = row.getByLabel(`Status for ${title} (Status is locked while the agent runs.)`);
  await expect(select).toBeDisabled({ timeout: 10_000 });
  const autoAssign = row.getByRole('button', { name: `Auto-assign ${title}` });
  await expect(autoAssign).toBeDisabled();
  await expect(autoAssign).toHaveAttribute('title', 'Status is locked while the agent runs.');

  // board: drag is off at dragstart, the card says why, the kebab Move-to path
  // is disabled with the same hint, and the drawer hint reads steering
  await page.evaluate(() => localStorage.setItem('tasks:view', 'board'));
  await page.goto('/tasks');
  await waitForHydration(page);
  const card = page.locator('article').filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('draggable', 'false');
  await expect(card.getByTestId('board-card-locked')).toContainText('locked while the agent runs');

  await card.hover();
  await card.getByRole('button', { name: `Actions for ${title}` }).click();
  const menu = page.getByRole('dialog', { name: `Actions for ${title}` });
  await expect(page.getByTestId('move-to-locked')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Doing' })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Done' })).toBeDisabled();
  // unlock the menu for the drawer entry — the popover CONTENT portals out of
  // the card, so the Workflow item rides the menu dialog, not the article
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: `Actions for ${title}` }).click();
  await page
    .getByRole('dialog', { name: `Actions for ${title}` })
    .getByRole('button', { name: 'Workflow' })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Task workflow' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('drawer-composer-hint')).toContainText('steering', { timeout: 10_000 });
});

test('run lock: the mobile card kebab disables Move-to with the hint (#264)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const title = `RUNLOCKM ${tag}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  // create at desktop width (the table renders rows, not cards), seed, then shrink
  const { taskId } = await createRow(page, tasks, title);
  await seedRunningRun(taskId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks');
  await waitForHydration(page);
  // the mobile card's kebab is the only action surface — go straight to it
  const kebab = page.getByRole('button', { name: `Actions for ${title}` }).first();
  await expect(kebab).toBeVisible({ timeout: 15_000 });
  await kebab.click();
  const menu = page.getByRole('dialog', { name: `Actions for ${title}` });
  await expect(page.getByTestId('move-to-locked')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Doing' })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Done' })).toBeDisabled();
});

test('composer hint: blocked AI task promises dispatch on both surfaces; human task reads thread-only (#265)', async ({
  page,
}) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const bot = await seedAiEmployee(page, tag);
  const aiTitle = `HINTAI ${tag}`;
  const humanTitle = `HINTHU ${tag}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);

  // born ineligible: the AI task attaches its assignee AFTER the hold is set,
  // so the 5s scan can never claim it while the moves happen
  const ai = await createRow(page, tasks, aiTitle);
  await holdScan(ai.taskId);
  await attachAssignee(page, ai.taskId, bot.id);
  await expect(ai.row).toContainText(bot.name, { timeout: 10_000 });
  // leave ready (the old hint's only dispatch state) — blocked still dispatches
  await page.locator('tbody').getByLabel(`Status for ${aiTitle}`).click();
  await page.getByRole('option', { name: 'Blocked' }).click();
  await expect(ai.row).toContainText('Blocked', { timeout: 10_000 });

  await createRow(page, tasks, humanTitle);

  // task page: hint span + the send's accessible name promise dispatch
  await ai.row.getByRole('link', { name: aiTitle }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${ai.taskId}`));
  await waitForHydration(page);
  await expect(page.getByText('Sends the note and dispatches the agent')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Sends the note and dispatches the agent' })).toBeVisible();

  // drawer on /tasks: the same wording on the hint line and the send button
  await page.goto('/tasks');
  await waitForHydration(page);
  let drawer = await tasks.openWorkflowDrawer(tasks.rowFor(aiTitle));
  await expect(drawer.getByTestId('drawer-composer-hint')).toHaveText('Sends the note and dispatches the agent');
  await expect(drawer.getByRole('button', { name: 'Sends the note and dispatches the agent' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  // human assignee: thread-only on both surfaces — never a dispatch promise
  drawer = await tasks.openWorkflowDrawer(tasks.rowFor(humanTitle));
  await expect(drawer.getByTestId('drawer-composer-hint')).toHaveText('Adds the note to the thread');
});
