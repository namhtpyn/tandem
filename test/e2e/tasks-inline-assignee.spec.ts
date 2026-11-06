// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

// #333: assignment is ONE pick on the list surface — the desktop row's Assignee
// select and the assignee line on mobile/board cards all run tasks.update with
// the same optimistic display, busy gate and run-lock as the status select.
//
// Optimistic display is proven by HOLDING the update request (the control flips
// before the response); every write is proven by the post-mutation success line
// (set only after the mutation resolves) and a reload.

async function seedRunningRun(taskId: string) {
  // one message per run turn (the thread's message→run relation is 1:1); ids are
  // explicit — schema defaults are app-side (drizzle), not SQL DEFAULTs
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const msgId = crypto.randomUUID();
  await sql`insert into task_messages (id, task_id, body, created_at) values (${msgId}, ${taskId}, 'assign-lock probe turn', now())`;
  await sql`insert into task_runs (id, message_id, status, output, started_at)
    values (${crypto.randomUUID()}, ${msgId}, 'RUNNING', '', now())`;
  await sql.close();
}

/** the list/board delete verb refuses while a run is live — clear the seed first */
async function clearRuns(taskId: string) {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  await sql`delete from task_runs where message_id in (select id from task_messages where task_id = ${taskId})`;
  await sql`delete from task_messages where task_id = ${taskId}`;
  await sql.close();
}

test('inline assignee: list select and board/mobile cards reassign without the editor', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  const title = `E2E Assignee ${suffix}`;
  await tasks.navigate('/tasks');
  await tasks.createTask({ title });

  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const href = await row.locator('a[href^="/tasks/"]').first().getAttribute('href');
  expect(href, 'row links to the task page').toBeTruthy();
  const taskId = (href as string).split('/').pop() as string;

  // ---- desktop cell: hold the write, the row must flip to Admin BEFORE it lands
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/rpc/tasks/update', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('tbody').getByLabel(`Assignee for ${title}`).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await expect(row).toContainText('Admin', { timeout: 5_000 });
  release();
  await expect(page.getByText('Assigned to Admin', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.unroute('**/rpc/tasks/update');

  // the write is server-side: a reload keeps it
  await page.reload();
  await waitForHydration(page);
  await expect(tasks.rowFor(title)).toContainText('Admin', { timeout: 15_000 });

  // ---- board card: same control on the assignee line, same optimistic contract
  await page.getByRole('button', { name: 'Board view' }).click();
  const todoCol = page.getByTestId('board-column').filter({ hasText: 'To do' }).first();
  const card = todoCol.locator('article').filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  let releaseCard!: () => void;
  const cardGate = new Promise<void>((resolve) => (releaseCard = resolve));
  await page.route('**/rpc/tasks/update', async (route) => {
    await cardGate;
    await route.continue();
  });
  await card.getByLabel(`Assignee for ${title}`).click();
  await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
  await expect(card).toContainText('Unassigned', { timeout: 5_000 });
  releaseCard();
  await expect(page.getByText('Assignee cleared', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.unroute('**/rpc/tasks/update');

  // …and the forward write from the card too (clear alone would leave it unproven)
  await card.getByLabel(`Assignee for ${title}`).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await expect(page.getByText('Assigned to Admin', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Admin', { timeout: 10_000 });

  // ---- mobile card at phone width: the meta line is the control
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('tasks:view', 'list'));
  await page.reload();
  await waitForHydration(page);
  const mobileControl = page.getByRole('combobox', { name: `Assignee for ${title}` });
  await expect(mobileControl).toBeVisible({ timeout: 15_000 });
  await mobileControl.click();
  await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
  await expect(page.getByText('Assignee cleared', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole('combobox', { name: `Assignee for ${title}` })).toContainText('Unassigned', {
    timeout: 15_000,
  });

  // ---- RUN LOCK: a live run disables every assignee control with the honest hint
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedRunningRun(taskId);
  await page.goto('/tasks');
  await waitForHydration(page);
  const locked = page.getByRole('combobox', {
    name: `Assignee for ${title} (Assignee is locked while the agent runs.)`,
  });
  await expect(locked).toBeDisabled({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Board view' }).click();
  const lockedCard = page
    .getByTestId('board-column')
    .filter({ hasText: 'To do' })
    .first()
    .locator('article')
    .filter({ hasText: title })
    .first();
  await expect(lockedCard.getByLabel(`Assignee for ${title} (Assignee is locked while the agent runs.)`)).toBeDisabled({
    timeout: 15_000,
  });

  // deleteTask reads the LIST view — the board preference is persisted client-side
  await page.evaluate(() => localStorage.setItem('tasks:view', 'list'));
  await clearRuns(taskId);
  await tasks.deleteTask(title);
});
