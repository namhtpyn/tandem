import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

test('graph view renders the supervision hierarchy', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await login(page)
  await page.goto('/employees')
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible()

  // supervisor first
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Full name').fill(`Graph Boss ${suffix}`)
  await page.getByPlaceholder('name@company.com').fill(`graph-boss-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Job title').fill('Lead')
  await page.getByRole('button', { name: /Create employee/ }).click()
  await expect(page.locator('tr:visible', { hasText: `Graph Boss ${suffix}` })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()

  // report
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Full name').fill(`Graph Sub ${suffix}`)
  await page.getByPlaceholder('name@company.com').fill(`graph-sub-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Job title').fill('Dev')
  await page.getByRole('button', { name: 'Supervisors', exact: true }).click()
  await page.getByRole('option', { name: `Graph Boss ${suffix}` }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Create employee/ }).click()
  await expect(page.locator('tr:visible', { hasText: `Graph Sub ${suffix}` })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()

  // graph view
  await page.getByRole('button', { name: 'Graph view' }).click()
  const svg = page.locator('svg[aria-label="Supervision hierarchy"]')
  await expect(svg).toBeVisible({ timeout: 10_000 })
  await expect(svg.getByText(`Graph Boss ${suffix}`)).toBeVisible()
  await expect(svg.getByText(`Graph Sub ${suffix}`)).toBeVisible()
})
