import { expect, test } from '@playwright/test';

import { login } from './helpers/login';

test('board view renders columns from statuses and moves a task', async ({ page }) => {
  await login(page);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: /Tasks/ })).toBeVisible();

  // create a task
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill('Kanban E2E');
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText('Kanban E2E').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });

  // switch to board
  await page.getByRole('button', { name: 'Board view' }).click();
  await expect(page.getByText('To do').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Done').first()).toBeVisible();

  // move via card status select: todo -> doing allowed by seed transitions
  await page.getByRole('combobox', { name: 'Status for Kanban E2E' }).filter({ visible: true }).first().click();
  await page.getByRole('option', { name: 'Doing', exact: true }).click();
  await expect(page.getByText('Doing', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});

test('statuses manager: add a custom status with transition', async ({ page }) => {
  await login(page);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Statuses' }).click();
  await expect(page.getByText('Task statuses')).toBeVisible();

  await page.getByRole('button', { name: 'New status' }).click();
  await page.getByPlaceholder('e.g. In review').fill('In review');
  await page.getByRole('button', { name: 'Save status' }).click();
  await page.waitForTimeout(1200);
  // manager reopens? It closed — reopen and check the list
  await page.getByRole('button', { name: 'Statuses' }).click();
  await expect(page.getByText('In review').first()).toBeVisible({ timeout: 10_000 });
});
