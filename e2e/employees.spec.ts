import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// M3: employees — live CRUD over oRPC /rpc, SSE realtime, AI keys.
// Every run uses unique emails/names (leftover state must not break retries).

test('human employee CRUD round-trip on the live page', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const name = `E2E Human ${suffix}`
  const email = `e2e-human-${suffix}@tandem.local`
  await login(page)
  await page.getByRole('link', { name: /Employees/ }).click()
  // wait for the live snapshot (admin row may or may not exist; empty state or table)
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible()

  // create human
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Jane Doe').fill(name)
  await page.getByPlaceholder('jane@company.com').fill(email)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Senior Engineer').fill('E2E Tester')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(email).first()).toBeVisible()

  // edit title
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Edit employee' }).click()
  await page.getByPlaceholder('Senior Engineer').fill('Promoted Tester')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Promoted Tester').first()).toBeVisible({ timeout: 15_000 })

  // delete (scoped to this row)
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Delete employee' }).click()
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 15_000 })
})

test('AI employee create shows minted key once, kind immutable on edit', async ({ page }) => {
  const suffix = Date.now().toString(36)
  // prerequisite environment for AI employees
  const envName = `e2e-env-${suffix}`
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).first().click()
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('ct112-tandem').fill(envName)
  await page.getByPlaceholder('192.168.3.108').fill('127.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(envName).first()).toBeVisible({ timeout: 15_000 })

  // create AI employee
  const name = `E2E Bot ${suffix}`
  const email = `e2e-bot-${suffix}@tandem.local`
  await page.getByRole('link', { name: /Employees/ }).click()
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Jane Doe').fill(name)
  await page.getByPlaceholder('jane@company.com').fill(email)
  await page.getByRole('radio', { name: /AI agent/ }).check()
  await page.getByPlaceholder('Senior Engineer').fill('Review Bot')
  // AI REQUIRES an environment — pick the one created above
  await page.getByRole('button', { name: 'Environment', exact: true }).click()
  await page.getByRole('option', { name: envName }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  // minted key surfaces once
  await expect(page.getByText(/shown once/i)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 })

  // edit: kind immutable badge, no kind radio
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Edit employee' }).click()
  await expect(page.getByText(/immutable/i).first()).toBeVisible()
  await expect(page.getByRole('radio', { name: /AI agent/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()

  // keys drawer: list + mint + revoke
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'API keys' }).click()
  await expect(page.getByText(/ai-key/).first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Mint new key' }).click()
  await expect(page.getByText(/New key — shown once/i)).toBeVisible({ timeout: 15_000 })
  const keyRows = page.locator('div.flex.items-center.justify-between.gap-2.py-2')
  await expect(keyRows).toHaveCount(2, { timeout: 15_000 })
  // revoke both — deterministic teardown
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Revoke key' }).first().click()
    await page.waitForTimeout(300)
  }
  await expect(page.getByText('No keys.')).toBeVisible({ timeout: 15_000 })
})

test('supervision: assign supervisors on create, reflected live', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await login(page)
  await page.getByRole('link', { name: /Employees/ }).click()
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible()

  // create the supervisor
  const supName = `E2E Sup ${suffix}`
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Jane Doe').fill(supName)
  await page.getByPlaceholder('jane@company.com').fill(`e2e-sup-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Senior Engineer').fill('Boss')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(supName).first()).toBeVisible({ timeout: 15_000 })

  // create the report with supervisor assigned
  const subName = `E2E Sub ${suffix}`
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Jane Doe').fill(subName)
  await page.getByPlaceholder('jane@company.com').fill(`e2e-sub-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Senior Engineer').fill('Report')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(subName).first()).toBeVisible({ timeout: 15_000 })

  // edit the report: pick the supervisor in the multi-select
  await page.locator('tr', { hasText: subName }).getByRole('button', { name: 'Edit employee' }).click()
  await page.getByRole('button', { name: 'Supervisors', exact: true }).click()
  await page.getByRole('option', { name: supName }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Save' }).click()

  // supervisor badge appears on the report row (scoped to that row)
  const row = page.locator('tr', { hasText: subName })
  await expect(row.getByText(supName, { exact: true })).toBeVisible({ timeout: 15_000 })

  // cleanup both rows
  await page.locator('tr', { hasText: subName }).getByRole('button', { name: 'Delete employee' }).click()
  await expect(page.getByText(subName)).toHaveCount(0, { timeout: 15_000 })
  await page.locator('tr', { hasText: supName }).getByRole('button', { name: 'Delete employee' }).click()
  await expect(page.getByText(supName)).toHaveCount(0, { timeout: 15_000 })
})
