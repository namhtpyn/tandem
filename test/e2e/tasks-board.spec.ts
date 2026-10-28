// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { expect, test } from './helpers/cleanup';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';

test('board view renders columns from statuses and moves a task by drag & drop', async ({ page }) => {
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: /Tasks/ })).toBeVisible();

  // create a task (unique per run — the DB is shared across specs and retries)
  const title = `Kanban E2E ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText(title).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });

  // switch to board: one horizontally scrollable row of status columns
  await page.getByRole('button', { name: 'Board view' }).click();
  const columns = page.getByTestId('board-column');
  await expect(columns.filter({ hasText: 'To do' }).first()).toBeVisible();
  await expect(columns.filter({ hasText: 'Done' }).first()).toBeVisible();

  // the new card sits in the To-do column
  const todoCol = columns.filter({ hasText: 'To do' }).first();
  await expect(todoCol.getByRole('link', { name: title })).toBeVisible();

  // drag the card onto the Doing column — the drop IS the status move
  // (cards carry no in-card status select; the column owns the status)
  const doingCol = columns.filter({ hasText: 'Doing' }).first();
  await todoCol.getByRole('link', { name: title }).dragTo(doingCol);
  await expect(doingCol.getByRole('link', { name: title })).toBeVisible({ timeout: 10_000 });
  await expect(todoCol.getByRole('link', { name: title })).toHaveCount(0, { timeout: 10_000 });

  // empty columns render as compact dashed drop zones, not stretched slabs
  await expect(columns.filter({ hasText: 'Cancelled' }).first()).toContainText('Drop tasks here');

  // teardown: the run's task must not linger in the shared DB
  await page.getByRole('button', { name: 'List view' }).click();
  const row = page.locator('tr:visible', { hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: /Delete / }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page.locator('tr:visible', { hasText: title })).toHaveCount(0, { timeout: 15_000 });
});

test('statuses manager: create, edit, transitions line, and delete a custom status', async ({ page }) => {
  const statusName = `E2E Status ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Statuses' }).click();
  await expect(page.getByText('Task statuses')).toBeVisible();

  // create (create-mode submit reads 'Create status')
  await page.getByRole('button', { name: 'New status' }).click();
  await page.getByPlaceholder('e.g. In review').fill(statusName);
  await page.getByRole('button', { name: 'Create status' }).click();
  // the editor closes onto the STILL-OPEN manager (stacked modals) — settled
  // once the editor's save button leaves while the manager heading remains
  await expect(page.getByRole('button', { name: 'Create status' })).toBeHidden({ timeout: 10_000 });
  const row = page
    .locator('div', { hasText: statusName })
    .filter({ has: page.getByRole('button', { name: new RegExp(`Edit ${statusName}`) }) })
    .last();
  await expect(row).toBeVisible();
  // a fresh status carries its transitions line (none yet)
  await expect(row).toContainText('No transitions');

  // edit mode: the submit reads 'Save changes' and a rename lands in the list
  await row.getByRole('button', { name: new RegExp(`Edit ${statusName}`) }).click();
  await page.getByPlaceholder('e.g. In review').fill(`${statusName} v2`);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeHidden({ timeout: 10_000 });
  const renamed = page
    .locator('div', { hasText: `${statusName} v2` })
    .filter({ has: page.getByRole('button', { name: new RegExp(`Delete ${statusName} v2`) }) })
    .last();
  await expect(renamed).toBeVisible({ timeout: 10_000 });

  // delete flow: two-step confirm, the row disappearing is the proof
  await renamed.getByRole('button', { name: new RegExp(`Delete ${statusName} v2`) }).click();
  await expect(page.getByRole('heading', { name: 'Delete status' })).toBeVisible();
  await page
    .locator('[role="dialog"]', { has: page.getByRole('heading', { name: 'Delete status' }) })
    .last()
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByText(`${statusName} v2`)).toHaveCount(0, { timeout: 10_000 });
});
