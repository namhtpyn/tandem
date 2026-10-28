// the cleanup fixture sweeps every row the test created (envs, bots, keys)
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test('task CRUD round-trip, assignee badge, status via select', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  await tasks.navigate('/tasks');

  // create via the toolbar button
  await tasks.createTask({ title: `E2E Task ${suffix}`, description: 'created by e2e', assignee: 'Admin' });
  await expect(tasks.rowFor(`E2E Task ${suffix}`)).toBeVisible({ timeout: 15_000 });

  // status flip via the inline select (task descriptions no longer render on the list)
  await page.locator('tbody').getByLabel(`Status for E2E Task ${suffix}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(`E2E Task ${suffix}`)).toContainText('Doing', { timeout: 10_000 });

  // edit: rename + reassign UI opens with values (scoped to THIS task's row —
  // leftovers from other specs share the DB and can sort first)
  await tasks
    .rowFor(`E2E Task ${suffix}`)
    .getByRole('button', { name: `Edit E2E Task ${suffix}` })
    .click();
  await expect(page.getByPlaceholder('Task title')).toHaveValue(`E2E Task ${suffix}`);
  await tasks.fillTaskForm({ title: `E2E Task ${suffix} v2` });
  await tasks.saveTask();
  await expect(tasks.rowFor(`E2E Task ${suffix} v2`)).toBeVisible({ timeout: 15_000 });

  // delete requires confirmation
  await tasks
    .rowFor(`E2E Task ${suffix} v2`)
    .getByRole('button', { name: `Delete E2E Task ${suffix} v2` })
    .click();
  await expect(page.getByRole('dialog').getByText(/cannot be undone/i)).toBeVisible();
  await tasks.confirmDelete();
  await expect(tasks.rowFor(`E2E Task ${suffix} v2`)).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('task assignee picker lists AI employees with (AI)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);

  // prerequisite: an environment + an AI employee
  const envName = `e2e-env-${suffix}`;
  await tasks.navigate('/environments');
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByPlaceholder('Environment name').fill(envName);
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1');
  await page.getByRole('textbox', { name: /Username/ }).fill('tandem');
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(page.locator('tr', { hasText: envName }).first()).toBeVisible({ timeout: 15_000 });

  const botName = `E2e Bot ${suffix}`;
  await tasks.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(botName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-bot-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /AI agent/ }).check();
  await page.getByPlaceholder('hermes acp').fill('hermes acp');
  await page.getByPlaceholder('Job title').fill('Runner');
  await page.getByRole('button', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: envName }).click();
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done, key saved/ }).click();
  await expect(page.locator('tr:visible', { hasText: botName })).toBeVisible({ timeout: 15_000 });

  // tasks: picker shows the bot with (AI)
  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: `AI task ${suffix}` });
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await expect(page.getByRole('option', { name: new RegExp(botName) }).first()).toContainText('(AI)');
  await page
    .getByRole('option', { name: new RegExp(botName) })
    .first()
    .click();
  await tasks.saveTask();
  // row shows the bot as assignee (scoped to THIS task's row)
  await expect(tasks.rowFor(`AI task ${suffix}`)).toContainText(botName, { timeout: 15_000 });
});

test('workflow drawer shows activity and lets the owner answer', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  await tasks.navigate('/tasks');
  // create a task owned by admin
  await tasks.createTask({ title: `WF ${suffix}` });
  // open the workflow drawer (row-scoped locator: immune to live re-renders of sibling rows)
  const row = tasks.rowFor(`WF ${suffix}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByText(/no activity yet/i)).toBeVisible();
  // the composer posts a plain note (no state change, no verb picker)
  await drawer.locator('textarea').fill('who owns the spec?');
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(drawer.getByText('Note added', { exact: true })).toBeVisible({ timeout: 10_000 });
});

test('workflow drawer streams an agent run to completion', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  const envName = `e2e-runenv-${suffix}`;
  const botName = `E2e Runner ${suffix}`;
  // prerequisite: environment + AI employee
  await tasks.navigate('/environments');
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByPlaceholder('Environment name').fill(envName);
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1');
  await page.getByRole('textbox', { name: /Username/ }).fill('tandem');
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(page.locator('tr', { hasText: envName }).first()).toBeVisible({ timeout: 15_000 });
  await tasks.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(botName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-runner-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /AI agent/ }).check();
  await page.getByPlaceholder('hermes acp').fill('hermes acp');
  await page.getByPlaceholder('Job title').fill('Runner');
  await page.getByRole('button', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: envName }).click();
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await page.getByRole('button', { name: /Done, key saved/ }).click();
  await tasks.navigate('/tasks');
  // create a task assigned to the AI employee
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: `Run ${suffix}` });
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await page
    .getByRole('option', { name: new RegExp(botName) })
    .first()
    .click();
  await tasks.saveTask();
  // open the workflow drawer (row-scoped locator); the row must carry the
  // assigned bot before the auto-dispatcher can pick the task up
  const row = tasks.rowFor(`Run ${suffix}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(botName);
  const drawer = await tasks.openWorkflowDrawer(row);
  // the auto-dispatcher (fake runner) picks the ready task up and streams output
  // the submitted result also lands in the thread as the verdict note — scope to the run output
  await expect(
    drawer
      .locator('pre')
      .getByText(/RESULT: task complete/i)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  // the run card reads as a sentence; exit code 0 is hidden
  await expect(drawer.getByText(/Run completed/i)).toBeVisible();
});
