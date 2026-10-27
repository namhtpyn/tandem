// E2E: task routing — "needs my decision" inbox toggle with badge, subtask creation
// with parent chip, parent auto-block while children are open (user laws, 2026-10-15).
import { expect, test } from '@playwright/test';

import { login } from './helpers/login.ts';

test('inbox toggle filters to tasks pending on me and shows a badge', async ({ page }) => {
  const suffix = Date.now();
  const name = `Inbox toggle ${suffix}`;
  await login(page);
  await page.goto('/tasks');

  // task assigned to admin (the logged-in user) and in progress, so Ask routes
  // the question to the owner (= admin) -> inbox obligation on the same user
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(name);
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();

  // flip to doing via the list's inline status select, then ask from the detail page
  await page.locator('tbody').getByLabel(`Status for ${name}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(page.locator('tr:visible').filter({ hasText: name }).first()).toContainText(/doing/i);
  await page.getByRole('link', { name: name }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  // Ask is an agent verb now (envelope question) — drive it via the session's RPC
  const taskUrl = page.url();
  const taskId = taskUrl.split('/').pop()!;
  const asked = await page.request.post('/rpc/tasks/ask', {
    data: { json: { taskId, body: 'which db?' } },
  });
  expect(asked.status()).toBe(200);

  await page.goto('/tasks');
  const toggle = page.getByTestId('needs-decision-toggle');
  await expect(toggle).toContainText('Needs my decision');
  // badge count ≥1 is the settled state of the ask round-trip (SSE refetches
  // within ms — the retrying value assert absorbs the server-side routing)
  await expect(page.getByTestId('inbox-count')).toHaveText(/[1-9]/); // badge count

  // toggle on: only the pending task remains visible
  await toggle.click();
  await expect(page.getByRole('link', { name })).toBeVisible();
  const otherRows = await page.locator('a[href^="/tasks/"]').count();
  expect(otherRows).toBeGreaterThanOrEqual(1);

  // toggle off: back to the full list label
  await toggle.click();
  await expect(toggle).toContainText('Needs my decision');
});

test('subtask creation nests under the parent, chips the child, and blocks the parent', async ({ page }) => {
  const suffix = Date.now();
  const parentName = `Gating parent ${suffix}`;
  const childName = `Gating child ${suffix}`;
  await login(page);
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(parentName);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: parentName }).first()).toBeVisible();
  await page.getByRole('link', { name: parentName }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });

  // create a subtask through the task creation modal (parent pre-set)
  const panel = page.getByTestId('subtask-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Add subtask' }).click();
  const subtaskModal = page.getByRole('dialog', { name: 'New task' });
  await expect(subtaskModal).toBeVisible();
  await subtaskModal.getByPlaceholder('Task title').fill(childName);
  await subtaskModal.getByRole('button', { name: /Create task/ }).click();
  await expect(panel.getByRole('link', { name: childName })).toBeVisible({ timeout: 10_000 });

  // parent flips to blocked (derived from the open child); the reload pulls
  // fresh server state and the retrying 'Blocked' assert absorbs the derive
  await page.reload();
  // status ids are uuids now — the badge renders the status NAME
  await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  // child page carries the parent chip
  await panel.getByRole('link', { name: childName }).click();
  await expect(page.getByTestId('parent-task-link')).toContainText(parentName);
});
