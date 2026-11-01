// Task-page contextual workflow verbs (#177, SPEC): every verb renders ON the
// task page sidebar (desktop aside + mobile info sheet) ONLY where the server
// accepts it, and fires in ONE click — the /tasks workflow drawer is never a
// required round-trip. Pinned here: the AI-ready task shows Dispatch now (and
// never Submit), the dispatch lands a run end-to-end from the page (fake
// runner settles it), the human working task shows Submit/Cancel (never
// Dispatch), submit fires from the page, and cancel confirms inline.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

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
        email: `e2e-verbs-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Runner',
        environmentId: envId,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  return `E2E Bot ${tag}`;
}

async function openTaskPage(page: import('@playwright/test').Page, tasks: TasksPage, title: string): Promise<void> {
  await tasks.navigate('/tasks');
  await tasks.rowFor(title).getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
}

test('AI-assigned ready task: Dispatch now fires from the page in one click (#177)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `VBS AI ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: botName });
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  await openTaskPage(page, tasks, taskTitle);
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-dispatch')).toBeVisible({ timeout: 10_000 });
  // the server refuses submit for an AI assignee — the verb never renders
  await expect(verbs.getByTestId('task-verb-submit')).toHaveCount(0);

  // ONE click: dispatch from the page, no drawer round-trip
  await verbs.getByTestId('task-verb-dispatch').click();
  await expect(verbs.getByTestId('task-verb-message')).toHaveText('Agent dispatched', { timeout: 10_000 });
  // the verb disarms with the state: the task left ready once the run claimed it
  await expect(verbs.getByTestId('task-verb-dispatch')).toHaveCount(0, { timeout: 15_000 });
  // the fake runner settles the run: result envelope, no reviewers → done
  await expect(page.getByTestId('task-status-badge')).toHaveText('Done', { timeout: 30_000 });
});

test('human working task: Submit fires from the page; Dispatch never renders (#177)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const taskTitle = `VBS HUMAN ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  await openTaskPage(page, tasks, taskTitle);
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await expect(verbs.getByTestId('task-verb-submit')).toBeVisible({ timeout: 10_000 });
  await expect(verbs.getByTestId('task-verb-cancel')).toBeVisible();
  await expect(verbs.getByTestId('task-verb-dispatch')).toHaveCount(0);

  await verbs.getByTestId('task-verb-submit').click();
  // no reviewers → the submit completes immediately (review law); the verb block
  // unmounts with the terminal state, so the BADGE is the assertion here
  await expect(page.getByTestId('task-status-badge')).toHaveText('Done', { timeout: 15_000 });
});

test('human working task: Cancel confirms inline and lands cancelled (#177)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const taskTitle = `VBS CANCEL ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await tasks.saveTask();
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  await openTaskPage(page, tasks, taskTitle);
  const verbs = page.locator('aside').getByTestId('task-workflow-actions');
  await verbs.getByTestId('task-verb-cancel').click();
  // cancelling is terminal — the inline confirm stands between click and fire
  const confirm = verbs.locator('[role="alertdialog"]');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Confirm cancel' }).click();
  // the verb block unmounts with the terminal state — the badge is the assertion
  await expect(page.getByTestId('task-status-badge')).toHaveText('Cancelled', { timeout: 15_000 });
});
