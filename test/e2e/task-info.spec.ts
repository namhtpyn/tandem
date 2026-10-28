// E2E: task detail page (Paperclip-style) — create task via UI, click title, land on
// /tasks/:id: chat thread present (brief + composer), sidebar info present, mobile sheet
// carries the same info, back link returns to the list.
import { expect, test } from '@playwright/test';

import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

test('task title click opens the task detail page', async ({ page }) => {
  const tasks = new TasksPage(page);
  const title = `Info page probe ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: title })).toHaveText(title);

  // chat main: empty thread placeholder + composer
  await expect(page.getByText('No activity yet — write a note below or dispatch the agent.')).toBeVisible();
  await expect(page.getByPlaceholder('Write a note…')).toBeVisible();

  // sidebar: Details section (the Workflow block is gone — status is manual)
  await expect(page.getByText('Details', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Workflow', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Status').first()).toBeVisible();
  await expect(page.getByText('Assignee').first()).toBeVisible();

  // back link returns to the list
  await page.getByRole('link', { name: 'Tasks', exact: false }).first().click();
  await expect(page).toHaveURL(/\/tasks$/);

  await tasks.deleteTask(title);
});

test('mobile: sidebar collapses into the info sheet', async ({ page }) => {
  const tasks = new TasksPage(page);
  const title = `Mobile sheet probe ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });

  // composer still primary on mobile; info opens as sheet
  await expect(page.getByPlaceholder('Write a note…')).toBeVisible();
  await page.getByTestId('task-info-trigger').click();
  // scope to the visible slideover (the desktop aside is display:none on mobile)
  await expect(page.getByLabel('Task info').getByText('Details', { exact: true })).toBeVisible();
  // status is a plain manual select now (the workflow block is gone)
  await expect(page.getByLabel('Task info').getByLabel('Task status')).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await tasks.deleteTask(title);
});
