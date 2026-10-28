// the cleanup fixture sweeps every row the test created (envs, bots, keys)
import { expect, test, type Page } from './helpers/cleanup';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

// Task detail Details section: assignee / project / status are editable selects
// (Nuxt UI USelect = role=combobox button + portal options). Manual status is
// free on every surface (owner ruling 2026-10-27); the run lock still blocks
// status/assignee edits while a run is live.

async function pickOption(page: Page, label: string, option: string) {
  const trigger = page.getByLabel(label);
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  return trigger;
}

test('details: change status and assignee from the sidebar', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  const employeeName = `E2E Fields ${suffix}`;
  const taskTitle = `Fields E2E ${suffix}`;
  await login(page);

  // seed one human employee so the assignee select has a real option
  await page
    .getByRole('link', { name: /Employees/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible();
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(employeeName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-fields-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('E2E Tester');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.locator('tr:visible', { hasText: employeeName })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done, key saved/ }).click();

  // create a task, then open its detail page via the title link
  await page.getByRole('link', { name: /Tasks/, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Tasks/ })).toBeVisible();
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(taskTitle);
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText(taskTitle).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: taskTitle }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(taskTitle) })).toBeVisible();

  // status: move along a seeded transition (To do -> Doing); trigger shows the new status
  const status = await pickOption(page, 'Task status', 'Doing');
  await expect(status).toContainText('Doing');

  // assignee: pick the seeded employee; survives a reload (persisted via tasks.update)
  const assignee = await pickOption(page, 'Task assignee', employeeName);
  await expect(assignee).toContainText(employeeName);
  await page.reload();
  await expect(page.getByRole('heading', { name: new RegExp(taskTitle) })).toBeVisible();
  await expect(page.getByLabel('Task assignee')).toContainText(employeeName);

  // project select renders with the empty option active (e2e seed has no projects)
  await expect(page.getByLabel('Task project')).toContainText('No project');

  // teardown: the run's task + employee must not linger in the shared DB
  await tasks.deleteTask(taskTitle);
  await page.goto('/employees');
  await waitForHydration(page);
  const search = page.getByPlaceholder('Search employees…');
  await search.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await search.isVisible()) await search.fill(employeeName);
  const row = page.locator('tr:visible', { hasText: employeeName }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: /Delete / }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page.locator('tr:visible', { hasText: employeeName })).toHaveCount(0, { timeout: 15_000 });
});

test('details: status select offers every status (manual moves are free)', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36);
  const taskTitle = `Fields E2E transitions ${suffix}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(taskTitle);
  await page.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByText(taskTitle).filter({ visible: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('link', { name: taskTitle }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(taskTitle) })).toBeVisible();

  // owner ruling 2026-10-27: the transition graph is advisory — every status is
  // manually selectable, including Done and Cancelled
  await page.getByLabel('Task status').click();
  const options = await page.getByRole('option').allTextContents();
  expect(options.some((o) => o.includes('To do'))).toBe(true);
  expect(options.some((o) => o.includes('Done'))).toBe(true);
  expect(options.some((o) => o.includes('Cancelled'))).toBe(true);

  await tasks.deleteTask(taskTitle);
});
