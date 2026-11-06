// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

// #333: assignment is ONE pick on the list surface — the desktop row's Assignee
// select and the assignee line on mobile/board cards both run tasks.update with
// the same optimistic display and run-lock gates as the status select.
//
// Every optimistic assertion is followed by a post-mutation signal (the success
// line is set only AFTER the mutation resolves) and a reload: the label alone
// proves the overlay, never the write.
test('inline assignee: list select and board card reassign without the editor', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  const title = `E2E Assignee ${suffix}`;
  await tasks.navigate('/tasks');
  await tasks.createTask({ title });

  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });

  // the row's Assignee cell is a select whose current value is Unassigned
  await page.locator('tbody').getByLabel(`Assignee for ${title}`).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await expect(page.getByText('Assigned to Admin', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('Admin', { timeout: 10_000 });

  // the write is server-side: a reload keeps it
  await page.reload();
  await expect(tasks.rowFor(title)).toContainText('Admin', { timeout: 15_000 });

  // board cards carry the same control on their assignee line — clear it there
  await page.getByRole('button', { name: 'Board view' }).click();
  const todoCol = page.getByTestId('board-column').filter({ hasText: 'To do' }).first();
  const card = todoCol.locator('article').filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByLabel(`Assignee for ${title}`).click();
  await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
  await expect(page.getByText('Assignee cleared', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Unassigned', { timeout: 10_000 });

  // and the clear stuck server-side too — the reload mounts the persisted board
  await page.reload();
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(tasks.rowFor(title)).toContainText('Unassigned', { timeout: 15_000 });

  await tasks.deleteTask(title);
});
