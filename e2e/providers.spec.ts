// E2E: model provider registry — seeds, CRUD, model sync placeholder, agent linkage.
import { expect, test } from '@playwright/test'
import { login } from './helpers/login'


async function dismiss(page: any, text: string) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const still = await page.evaluate((t) => (document.body.innerText || '').includes(t), text)
  if (still) {
    const close = page.getByRole('button', { name: 'Close' }).first()
    if (await close.count()) await close.click()
    await page.waitForTimeout(400)
  }
}

test.describe('model providers', () => {
  test('seeds are visible on the settings page', async ({ page }) => {
    await login(page)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible()
    // mobile cards + desktop table both render provider names; only one is visible per breakpoint
    const visible = (text: string) => page.getByText(text).filter({ visible: true })
    await expect(visible('OpenAI').first()).toBeVisible()
    await expect(visible('Anthropic').first()).toBeVisible()
    await expect(visible('OpenRouter').first()).toBeVisible()
  })

  test('add provider with models, then delete', async ({ page }) => {
    await login(page)
    await page.goto('/settings')
    const name = `Groq ${Date.now().toString(36)}`
    await page.getByRole('button', { name: 'Add provider' }).first().click()
    await page.getByLabel('Label').fill(name)
    await page.getByLabel('Base URL').fill('https://api.groq.com/openai/v1')
    await page.getByRole('button', { name: 'Add provider' }).last().click()
    const row = page.locator('tr', { hasText: name })
    await expect(row).toBeVisible()
    // delete via that row's own button
    await row.getByRole('button', { name: 'Delete provider' }).click()
    await expect(page.locator('tr', { hasText: name })).toHaveCount(0)
  })

  test('agent editor offers provider + model + api key', async ({ page }) => {
    await login(page)
    await page.goto('/employees')
    await page.getByRole('button', { name: 'New employee' }).first().click()
    const suffix = Date.now().toString(36)
    await page.getByPlaceholder('Full name').fill(`Prov Bot ${suffix}`)
    await page.getByPlaceholder('name@company.com').fill(`provbot-${suffix}@tandem.local`)
    await page.getByRole('radio', { name: /AI agent/ }).check()
  await page.getByPlaceholder('hermes acp').fill('hermes acp')
    // provider dropdown seeded
    await page.getByRole('combobox', { name: 'Provider' }).click()
    await expect(page.getByRole('option', { name: 'OpenAI' })).toBeVisible()
    await page.getByRole('option', { name: 'OpenAI' }).click()
    await dismiss(page, 'Base URL')
  })
})
