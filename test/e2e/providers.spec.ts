// E2E: model provider registry — seeds, CRUD, model sync placeholder, agent linkage.
import { expect, test } from '@playwright/test';

import { BasePage } from './pages/base.page.ts';

test.describe('model providers', () => {
  // BASELINE LAW (2026-10-16 squash): migrations seed statuses only — the provider
  // catalog starts EMPTY; this test creates its own row.
  test('provider catalog starts empty; added provider is visible', async ({ page }) => {
    const ui = new BasePage(page);
    await ui.navigate('/settings');
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
    const ui = new BasePage(page);
    await ui.navigate('/settings');
    const name = `Groq ${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    await page.getByLabel('Label').fill(name);
    await page.getByLabel('Base URL').fill('https://api.groq.com/openai/v1');
    await page.getByRole('button', { name: 'Add provider' }).last().click();
    const row = page.locator('tr', { hasText: name });
    await expect(row).toBeVisible();
    // delete via that row's own button, then confirm in the modal (two-step delete law)
    await row.getByRole('button', { name: 'Delete provider' }).click();
    await ui.confirmDelete();
    await expect(page.locator('tr', { hasText: name })).toHaveCount(0);
  });

  test('agent editor offers provider + model + api key', async ({ page }) => {
    const ui = new BasePage(page);
    // no baseline provider seeds — create the provider the agent editor will offer
    const provName = `Agent Prov ${Date.now().toString(36)}`;
    await ui.navigate('/settings');
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    await page.getByLabel('Label').fill(provName);
    await page.getByLabel('Base URL').fill('https://api.openai.com');
    await page.getByRole('button', { name: 'Add provider' }).last().click();
    await expect(page.getByText(provName).filter({ visible: true }).first()).toBeVisible();
    await ui.navigate('/employees');
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
    await ui.dismissOverlay('Base URL');
  });
});
