// E2E: projects — create, nest, task linkage.
import { expect, test } from './helpers/cleanup.ts';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';

test.describe('projects', () => {
  test('create a project, then a subproject, visible in tree', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await waitForHydration(page);
    const suffix = Date.now().toString(36);
    const parent = `Apollo ${suffix}`;
    const child = `Lander ${suffix}`;
    await page.getByRole('button', { name: 'New project' }).first().click();
    await page.getByPlaceholder('Project name').fill(parent);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(parent, { exact: true }).filter({ visible: true }).first()).toBeVisible();

    // subproject via row action (role-scoped row locator, no xpath)
    const row = page.locator('tr:visible', { hasText: parent }).first();
    await row.getByRole('button', { name: /Add subproject/ }).click();
    await page.getByPlaceholder('Project name').fill(child);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(child, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });

  test('task editor offers the project picker', async ({ page }) => {
    await login(page);
    const suffix = Date.now().toString(36);
    await page.goto('/projects');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'New project' }).first().click();
    await page.getByPlaceholder('Project name').fill(`Picker ${suffix}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(`Picker ${suffix}`, { exact: true }).filter({ visible: true }).first()).toBeVisible();

    await page.goto('/tasks');
    await waitForHydration(page);
    await page
      .getByRole('button', { name: /New task|Add task/ })
      .first()
      .click();
    await expect(page.getByPlaceholder(/task title|Brief title/i)).toBeVisible();
    await page.getByPlaceholder(/task title|Brief title/i).fill(`Task ${suffix}`);
    await page.getByRole('button', { name: /^Project/ }).click();
    await page.getByRole('option', { name: `Picker ${suffix}` }).click();
    await page.getByRole('button', { name: /Save|Create task/ }).click();
    await expect(page.getByText(`Picker ${suffix}`).filter({ visible: true }).first()).toBeVisible();
  });
});
