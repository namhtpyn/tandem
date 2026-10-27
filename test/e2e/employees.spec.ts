import { expect, test } from '@playwright/test';

import { BasePage } from './pages/base.page.ts';

// M3: employees — live CRUD over oRPC /rpc, SSE realtime, AI keys.
// Every run uses unique emails/names (leftover state must not break retries).

// the list is server-paged (createdAt asc) — search surfaces fresh rows on
// page 1; the shared helper fills the debounced query and lets the callers'
// retrying row asserts absorb the refetch
const SEARCH = 'Search employees…';

test('human employee CRUD round-trip on the live page', async ({ page }) => {
  const ui = new BasePage(page);
  const suffix = Date.now().toString(36);
  const name = `E2E Human ${suffix}`;
  const email = `e2e-human-${suffix}@tandem.local`;
  await ui.navigate('/employees');
  // wait for the live snapshot (admin row may or may not exist; empty state or table)
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible();

  // create human
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(name);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('E2E Tester');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  // humans now also get an initial access key — dismiss the shown-once alert
  await page.getByRole('button', { name: /Done — I saved the key/ }).click();
  await ui.searchRows(SEARCH, name);
  await expect(page.locator('tr:visible', { hasText: name })).toBeVisible({ timeout: 15_000 });

  // edit title + email
  await page.locator('tr:visible', { hasText: name }).getByRole('button', { name: 'Edit employee' }).click();
  await page.getByPlaceholder('Job title').fill('Promoted Tester');
  await page.getByPlaceholder('name@company.com').fill(`renamed-${suffix}@tandem.local`);
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await ui.searchRows(SEARCH, name);
  await expect(page.locator('tr:visible', { hasText: name }).getByText('Promoted Tester')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('tr:visible', { hasText: name }).getByText(`renamed-${suffix}@tandem.local`)).toBeVisible({
    timeout: 15_000,
  });

  // delete requires CONFIRMATION now: trash opens a dialog, not instant delete
  await page.locator('tr:visible', { hasText: name }).getByRole('button', { name: 'Delete employee' }).click();
  await expect(page.getByRole('dialog').getByText(/permanently/i)).toBeVisible();
  await expect(page.locator('tr:visible', { hasText: name })).toBeVisible(); // still there pre-confirm
  await ui.confirmDelete();
  await expect(page.locator('tr:visible', { hasText: name })).toHaveCount(0, { timeout: 15_000 });
});

test('AI employee create shows minted key once, kind immutable on edit', async ({ page }) => {
  const ui = new BasePage(page);
  const suffix = Date.now().toString(36);
  // prerequisite environment for AI employees
  const envName = `e2e-env-${suffix}`;
  await ui.navigate('/environments');
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByPlaceholder('Environment name').fill(envName);
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.locator('tr', { hasText: envName }).first()).toBeVisible({ timeout: 15_000 });

  // create AI employee
  const name = `E2E Bot ${suffix}`;
  const email = `e2e-bot-${suffix}@tandem.local`;
  await ui.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(name);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByRole('radio', { name: /AI agent/ }).check();
  await page.getByPlaceholder('Job title').fill('Review Bot');
  // AI REQUIRES an environment — pick the one created above
  await page.getByRole('button', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: envName }).click();
  // ACP executable is required freetext (defaults typed by the operator)
  await page.getByPlaceholder('hermes acp').fill('hermes acp');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  // minted key surfaces once
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done — I saved the key/ }).click();
  await ui.searchRows(SEARCH, name);
  await expect(page.locator('tr:visible', { hasText: name })).toBeVisible({ timeout: 15_000 });

  // edit: kind immutable badge, no kind radio
  await page.locator('tr:visible', { hasText: name }).getByRole('button', { name: 'Edit employee' }).click();
  await expect(page.getByText(/immutable/i).first()).toBeVisible();
  await expect(page.getByRole('radio', { name: /AI agent/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // keys drawer: list + mint + revoke
  await page.locator('tr:visible', { hasText: name }).getByRole('button', { name: 'Access keys' }).click();
  await expect(page.getByText(/employee .{8}|-key/, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Mint new key' }).click();
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  const keyRows = page.locator('div.flex.items-center.justify-between.gap-2.py-2');
  await expect(keyRows).toHaveCount(2, { timeout: 15_000 });
  // revoke both — deterministic teardown; the count assert settles each revoke
  // before the next iteration re-resolves '.first()'
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Revoke key' }).first().click();
    await expect(keyRows).toHaveCount(1 - i, { timeout: 10_000 });
  }
  await expect(page.getByText('No keys.')).toBeVisible({ timeout: 15_000 });

  // teardown: delete the bot, then its environment (leftover env rows break
  // other suites' unscoped selectors; keep the DB tidy)
  await ui.dismissOverlay('Edit employee');
  await ui.navigate('/employees');
  await page.locator('tr:visible', { hasText: name }).getByRole('button', { name: 'Delete employee' }).click();
  await ui.confirmDelete();
  await expect(page.locator('tr', { hasText: name })).toHaveCount(0, { timeout: 15_000 });
  await ui.navigate('/environments');
  await page.locator('tr:visible', { hasText: envName }).getByRole('button', { name: 'Delete environment' }).click();
  await ui.confirmDelete();
  await expect(page.locator('tr', { hasText: envName })).toHaveCount(0, { timeout: 15_000 });
});

test('supervision: assign supervisors on create, reflected live', async ({ page }) => {
  const ui = new BasePage(page);
  const suffix = Date.now().toString(36);
  await ui.navigate('/employees');
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible();

  // create the supervisor
  const supName = `E2E Sup ${suffix}`;
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(supName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-sup-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('Boss');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done — I saved the key/ }).click();
  await ui.searchRows(SEARCH, supName);
  await expect(page.locator('tr:visible', { hasText: supName })).toBeVisible({ timeout: 15_000 });

  // create the report with supervisor assigned
  const subName = `E2E Sub ${suffix}`;
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(subName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-sub-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('Report');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done — I saved the key/ }).click();
  await ui.searchRows(SEARCH, subName);
  await expect(page.locator('tr:visible', { hasText: subName })).toBeVisible({ timeout: 15_000 });

  // edit the report: pick the supervisor in the multi-select
  await page.locator('tr:visible', { hasText: subName }).getByRole('button', { name: 'Edit employee' }).click();
  await page.getByRole('button', { name: 'Supervisors', exact: true }).click();
  await page.getByRole('option', { name: supName }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();

  // supervisor badge appears on the report row (scoped to that row)
  const row = page.locator('tr', { hasText: subName });
  await expect(row.getByText(supName, { exact: true })).toBeVisible({ timeout: 15_000 });

  // cleanup both rows (with confirmation); search keeps each target on page 1
  await ui.searchRows(SEARCH, subName);
  await page.locator('tr:visible', { hasText: subName }).getByRole('button', { name: 'Delete employee' }).click();
  await ui.confirmDelete();
  await expect(page.locator('tr:visible', { hasText: subName })).toHaveCount(0, { timeout: 15_000 });
  await ui.searchRows(SEARCH, supName);
  await page.locator('tr:visible', { hasText: supName }).getByRole('button', { name: 'Delete employee' }).click();
  await ui.confirmDelete();
  await expect(page.locator('tr:visible', { hasText: supName })).toHaveCount(0, { timeout: 15_000 });
});
