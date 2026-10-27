// E2E: model provider registry — seeds, CRUD, model sync placeholder, agent linkage.
import { expect, test } from '@playwright/test';

import { login } from './helpers/login.ts';

async function dismiss(page: any, text: string) {
  await page.keyboard.press('Escape');
  // settled when the overlay's sentinel text no longer reads from the body —
  // polled, not slept, so it rides out the close transition. A sentinel that
  // also lives behind the overlay (e.g. the row's own 'Edit employee' button)
  // keeps the poll failing by design: the fallback then tries the overlay's
  // Close button, which no-ops when Escape already closed it.
  try {
    await expect
      .poll(() => page.evaluate((t: string) => (document.body.innerText || '').includes(t), text), { timeout: 1_500 })
      .toBe(false);
  } catch {
    const close = page.getByRole('button', { name: 'Close' }).first();
    if (await close.count()) await close.click();
  }
}

test.describe('model providers', () => {
  // BASELINE LAW (2026-10-16 squash): migrations seed statuses only — the provider
  // catalog starts EMPTY; this test creates its own row.
  test('provider catalog starts empty; added provider is visible', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible();
    const name = `OpenAI QA ${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    await page.getByLabel('Label').fill(name);
    await page.getByLabel('Base URL').fill('https://api.openai.com');
    await page.getByRole('button', { name: 'Add provider' }).last().click();
    // mobile cards + desktop table both render provider names; only one is visible per breakpoint
    await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
  });

  test('add provider with models, then delete', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    const name = `Groq ${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    await page.getByLabel('Label').fill(name);
    await page.getByLabel('Base URL').fill('https://api.groq.com/openai/v1');
    await page.getByRole('button', { name: 'Add provider' }).last().click();
    const row = page.locator('tr', { hasText: name });
    await expect(row).toBeVisible();
    // delete via that row's own button, then confirm in the modal (two-step delete law)
    await row.getByRole('button', { name: 'Delete provider' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.locator('tr', { hasText: name })).toHaveCount(0);
  });

  test('agent editor offers provider + model + api key', async ({ page }) => {
    await login(page);
    // no baseline provider seeds — create the provider the agent editor will offer
    const provName = `Agent Prov ${Date.now().toString(36)}`;
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    await page.getByLabel('Label').fill(provName);
    await page.getByLabel('Base URL').fill('https://api.openai.com');
    await page.getByRole('button', { name: 'Add provider' }).last().click();
    await expect(page.getByText(provName).filter({ visible: true }).first()).toBeVisible();
    await page.goto('/employees');
    await page.getByRole('button', { name: 'New employee' }).first().click();
    const suffix = Date.now().toString(36);
    await page.getByPlaceholder('Full name').fill(`Prov Bot ${suffix}`);
    await page.getByPlaceholder('name@company.com').fill(`provbot-${suffix}@tandem.local`);
    await page.getByRole('radio', { name: /AI agent/ }).check();
    await page.getByPlaceholder('hermes acp').fill('hermes acp');
    // provider dropdown offers the provider created above
    await page.getByRole('combobox', { name: 'Provider' }).click();
    await expect(page.getByRole('option', { name: provName })).toBeVisible();
    await page.getByRole('option', { name: provName }).click();
    await dismiss(page, 'Base URL');
  });
});
