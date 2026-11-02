// #210: the toolbar 'New task' button used to hide itself whenever the task
// list was empty and unfiltered (rows.length===0 && !listFiltered) and the
// board had no empty-state CTA — a zero-task board therefore had NO create
// entry at all. The fix always renders the toolbar button, so an empty board
// keeps a one-step create path on desktop AND at phone widths, and the list
// view's built-in empty-state CTA coexists with it instead of being the only
// entry. Board view is seeded raw: VueUse's useLocalStorage string serializer
// stores the RAW string, so localStorage.setItem('tasks:view','board') —
// never JSON.stringify.
import type { Page } from '@playwright/test';
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';

// the surface under test must START empty: wipe every task row up front
// (children cascade from tasks.id — messages/runs/obligations/attachments go
// with them). The dbCleanup fixture still sweeps whatever rows the test itself
// creates afterwards.
async function wipeTasks() {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    await sql.unsafe('delete from tasks');
  } finally {
    await sql.close();
  }
}

// the view toggle is a client-side localStorage preference — seed it, reload
// so the app MOUNTS straight into board view, re-gate hydration (login-flake law)
async function openTasksInBoardView(page: Page) {
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.evaluate(() => localStorage.setItem('tasks:view', 'board'));
  await page.reload();
  await waitForHydration(page);
}

test('#210 empty board keeps a one-step create entry (desktop)', async ({ page }) => {
  await wipeTasks();
  await login(page);
  await openTasksInBoardView(page);

  const columns = page.getByTestId('board-column');
  await expect(columns.filter({ hasText: 'To do' }).first()).toBeVisible();

  // acceptance #1: the create entry survives a zero-task board
  const title = `BoardEmpty ${Date.now().toString(36)}`;
  const newTask = page.getByRole('button', { name: 'New task' }).first();
  await expect(newTask).toBeVisible();
  await newTask.click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Create task/ }).click();

  // the new card lands in the To-do column WITHOUT any view switch
  const todoCol = columns.filter({ hasText: 'To do' }).first();
  await expect(todoCol.getByRole('link', { name: title })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('tr:visible', { hasText: title })).toHaveCount(0);

  // acceptance #2: delete the last task from the BOARD card kebab — once the
  // board empties again, the toolbar entry must STILL be there
  await todoCol.getByRole('button', { name: `Actions for ${title}` }).click();
  // popover's 'Delete' menu item (unique until the confirm dialog mounts)…
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  // …then the modal's own Delete, scoped to the dialog so the click can never
  // land on the still-open popover item (same pattern as the statuses spec)
  await page
    .locator('[role="dialog"]', { has: page.getByRole('heading', { name: 'Delete task' }) })
    .last()
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 15_000 });
  await expect(newTask).toBeVisible();
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('#210 empty board create entry is reachable at phone width', async ({ page }) => {
    await wipeTasks();
    await login(page);
    await openTasksInBoardView(page);

    const columns = page.getByTestId('board-column');
    await expect(columns.filter({ hasText: 'To do' }).first()).toBeVisible();

    // 'New task' is the LAST item in the horizontal action scroller — bring it
    // into view before asserting; h-11 is the 44px phone tap target
    const newTask = page.getByRole('button', { name: 'New task' }).first();
    await newTask.scrollIntoViewIfNeeded();
    await expect(newTask).toBeVisible();
    await expect(newTask).toHaveCSS('height', '44px');
    await newTask.click();

    const title = `BoardEmpty ${Date.now().toString(36)} m`;
    await page.getByPlaceholder('Task title').fill(title);
    await page.getByRole('button', { name: /Create task/ }).click();
    await expect(columns.filter({ hasText: 'To do' }).first().getByRole('link', { name: title })).toBeVisible({
      timeout: 15_000,
    });
    // teardown note: the card is left on purpose — the dbCleanup fixture
    // sweeps it, and the kebab-delete path is already covered on desktop
  });
});

test('#210 emptied list view: empty-state CTA and toolbar button coexist', async ({ page }) => {
  await wipeTasks();
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);

  // default view is list — the built-in empty state with its unfiltered copy
  await expect(page.getByText('No tasks yet')).toBeVisible();
  await expect(page.getByText('Create the first one for your humans or agents.')).toBeVisible();

  // regression guard: the fix makes BOTH create entries render together —
  // toolbar button first in the DOM, the DataTable empty-state CTA second
  const createButtons = page.getByRole('button', { name: 'New task' });
  await expect(createButtons).toHaveCount(2);
  await expect(createButtons.first()).toBeVisible();
  await expect(createButtons.last()).toBeVisible();

  // and the empty-state CTA still opens the editor
  await createButtons.last().click();
  await expect(page.getByPlaceholder('Task title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Task title')).toBeHidden({ timeout: 10_000 });
});
