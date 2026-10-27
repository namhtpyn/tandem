import { expect, test } from '@playwright/test';

import { login } from './helpers/login.ts';

test('board view renders columns from statuses and moves a task by drag & drop', async ({ page }) => {
  await login(page);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: /Tasks/ })).toBeVisible();

  // create a task
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill('Kanban E2E');
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText('Kanban E2E').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });

  // switch to board: one horizontally scrollable row of status columns
  await page.getByRole('button', { name: 'Board view' }).click();
  const columns = page.getByTestId('board-column');
  await expect(columns.filter({ hasText: 'To do' }).first()).toBeVisible();
  await expect(columns.filter({ hasText: 'Done' }).first()).toBeVisible();

  // the new card sits in the To-do column
  const todoCol = columns.filter({ hasText: 'To do' }).first();
  await expect(todoCol.getByRole('link', { name: 'Kanban E2E' })).toBeVisible();

  // drag the card onto the Doing column — the drop IS the status move
  // (cards carry no in-card status select; the column owns the status)
  const doingCol = columns.filter({ hasText: 'Doing' }).first();
  await todoCol.getByRole('link', { name: 'Kanban E2E' }).dragTo(doingCol);
  await expect(doingCol.getByRole('link', { name: 'Kanban E2E' })).toBeVisible({ timeout: 10_000 });
  await expect(todoCol.getByRole('link', { name: 'Kanban E2E' })).toHaveCount(0, { timeout: 10_000 });

  // empty columns render as compact dashed drop zones, not stretched slabs
  await expect(columns.filter({ hasText: 'Cancelled' }).first()).toContainText('Drop tasks here');
});

test('statuses manager: add a custom status with transition', async ({ page }) => {
  await login(page);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Statuses' }).click();
  await expect(page.getByText('Task statuses')).toBeVisible();

  await page.getByRole('button', { name: 'New status' }).click();
  await page.getByPlaceholder('e.g. In review').fill('In review');
  await page.getByRole('button', { name: 'Save status' }).click();
  // the editor closes onto the STILL-OPEN manager (stacked modals) — settled
  // once the editor's save button leaves while the manager heading remains
  await expect(page.getByRole('button', { name: 'Save status' })).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText('Task statuses')).toBeVisible();
  // close the manager, then reopen and check the list
  await page.keyboard.press('Escape');
  await expect(page.getByText('Task statuses')).toBeHidden();
  await page.getByRole('button', { name: 'Statuses' }).click();
  await expect(page.getByText('In review').first()).toBeVisible({ timeout: 10_000 });
});
