import { RUN_STATUS } from '#shared/enums';

import { expect, test } from './helpers/cleanup.ts';
import { BasePage } from './pages/base.page.ts';
import { waitForHydration } from './pages/base.page.ts';
import { VaultPage } from './pages/vault.page.ts';

// M2: environments — live CRUD over oRPC /rpc, SSE realtime, probe.

test('environment links a vault secret and shows it in the row', async ({ page }) => {
  const vault = new VaultPage(page);
  // create a secret first
  await vault.navigate('/vault');
  const secName = `e2e-env-key-${process.pid}-${Date.now().toString(36)}`;
  await vault.createSecret({ name: secName, value: 'e2e-key-material' });
  await expect(page.locator('tr:visible', { hasText: secName })).toBeVisible({ timeout: 15_000 });

  // create an environment linked to it
  await vault.navigate('/environments');
  const envName = `e2e-secret-box-${process.pid}-${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(envName);
  await page.getByRole('textbox', { name: 'Host' }).fill('10.9.8.7');
  await page.getByRole('textbox', { name: 'Username' }).fill('tandem');
  await page
    .locator('button')
    .filter({ hasText: /No key|••••/ })
    .first()
    .click();
  await page.getByRole('option', { name: new RegExp(secName) }).click();
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(page.locator('tr:visible', { hasText: envName })).toBeVisible({ timeout: 15_000 });

  // edit shows the linked key preselected
  await page.locator('tr:visible', { hasText: envName }).getByRole('button', { name: /Edit / }).click();
  await expect(page.locator('button').filter({ hasText: /••••/ }).first()).toContainText(secName.slice(0, 20));
  await vault.dismissOverlay('Username');

  // cleanup env
  await page
    .locator('tr:visible', { hasText: envName })
    .getByRole('button', { name: /Delete / })
    .click();
  await vault.confirmDelete();
  await expect(page.locator('tr:visible', { hasText: envName })).toHaveCount(0, { timeout: 15_000 });
});

test('environment CRUD round-trip on the live page', async ({ page }) => {
  const ui = new BasePage(page);
  const suffix = Date.now().toString(36);
  const rowName = `e2e-box-${suffix}`;
  await ui.navigate('/environments');
  // the suite DB is shared — other runs' environments may exist, so the empty
  // state is NOT assertable here; the run's own row visibility is the anchor

  // create
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByPlaceholder('Environment name').fill(rowName);
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1');
  await page.getByRole('textbox', { name: /Username/ }).fill('tandem');
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(page.locator('tr:visible', { hasText: rowName })).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('tr:visible', { hasText: rowName }).locator('span:visible', { hasText: '127.0.0.1' }),
  ).toBeVisible();

  // duplicate name -> conflict surfaced (single error node: page one is hidden while modal open)
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByPlaceholder('Environment name').fill(rowName);
  await page.getByPlaceholder('Hostname or IP').fill('10.0.0.1');
  await page.getByRole('textbox', { name: /Username/ }).fill('tandem');
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // edit host (scoped to this row — leftover rows from other specs exist)
  const row = page.locator('tr', { hasText: rowName });
  await row.getByRole('button', { name: /Edit / }).click();
  await page.getByPlaceholder('Hostname or IP').fill('10.9.8.7');
  await page.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(
    page.locator('tr:visible', { hasText: rowName }).locator('span:visible', { hasText: '10.9.8.7' }),
  ).toBeVisible({ timeout: 15_000 });

  // probe (refused port -> failed badge with detail), scoped to the row
  await row.getByRole('button', { name: /Test / }).click();
  await expect(page.locator('tr:visible', { hasText: rowName }).getByText(RUN_STATUS.FAILED)).toBeVisible({
    timeout: 20_000,
  });

  // delete requires confirmation, scoped to this row
  await page
    .locator('tr:visible', { hasText: rowName })
    .getByRole('button', { name: /Delete / })
    .click();
  await expect(page.getByRole('heading', { name: 'Delete environment' })).toBeVisible();
  await ui.confirmDelete();
  await expect(page.locator('tr', { hasText: rowName })).toHaveCount(0, { timeout: 15_000 });
});

test('live table updates from another tab via SSE', async ({ context, page }) => {
  const ui = new BasePage(page);
  const suffix = Date.now().toString(36);
  const rowName = `sse-ghost-${suffix}`;
  await ui.navigate('/environments');
  await expect(page.getByRole('heading', { name: /Environments/ })).toBeVisible();

  const other = await context.newPage();
  await other.goto('/environments');
  await waitForHydration(other);
  await expect(other.getByRole('heading', { name: /Environments/ })).toBeVisible();

  // create from the other tab; first tab must update without reload
  await other.getByRole('button', { name: 'New environment' }).first().click();
  await other.getByPlaceholder('Environment name').fill(rowName);
  await other.getByPlaceholder('Hostname or IP').fill('127.0.0.1');
  await other.getByRole('textbox', { name: /Username/ }).fill('tandem');
  await other.getByRole('button', { name: /Save changes|Create environment/ }).click();
  await expect(other.locator('tr', { hasText: rowName })).toBeVisible({ timeout: 15_000 });

  await expect(page.locator('tr:visible', { hasText: rowName })).toBeVisible({ timeout: 15_000 });

  // cleanup (scoped to this row, with confirmation)
  await page
    .locator('tr:visible', { hasText: rowName })
    .getByRole('button', { name: /Delete / })
    .click();
  await ui.confirmDelete();
  await expect(page.locator('tr', { hasText: rowName })).toHaveCount(0, { timeout: 15_000 });
  await other.close();
});

test.describe('unauthenticated', () => {
  // request fixture would inherit the project storageState and arrive logged-in
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated /rpc rejects with 401', async ({ request }) => {
    const res = await request.post('/rpc/environments/create', {
      headers: { 'content-type': 'application/json' },
      data: { json: { name: 'x', host: 'h', port: '22', username: 'u' } },
    });
    expect(res.status()).toBe(401);
  });
});
