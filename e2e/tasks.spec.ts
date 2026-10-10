import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// visible row/card: desktop tr or the mobile card stack (md:hidden)
const VISIBLE_ROW = 'tr:visible'

test('task CRUD round-trip, assignee badge, status via select', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await login(page)
  await page.goto('/tasks')

  // empty state -> create via modal
  await expect(page.getByText('No tasks yet')).toBeVisible()
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(`E2E Task ${suffix}`)
  await page.getByPlaceholder('Description (optional)').fill('created by e2e')
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await page.getByRole('option', { name: 'Admin' }).click()
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await expect(page.locator(VISIBLE_ROW).filter({ hasText: `E2E Task ${suffix}` }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('tr:visible').filter({ hasText: 'created by e2e' }).first()).toBeVisible()

  // status flip via the inline select
  await page.locator('tbody').getByLabel(`Status for E2E Task ${suffix}`).click()
  await page.getByRole('option', { name: 'Doing' }).click()
  await expect(page.locator('tr:visible').filter({ hasText: 'doing' }).first()).toBeVisible({ timeout: 10_000 })

  // edit: rename + reassign UI opens with values
  await page.getByRole('button', { name: 'Edit task' }).first().click()
  await expect(page.getByPlaceholder('Task title')).toHaveValue(`E2E Task ${suffix}`)
  await page.getByPlaceholder('Task title').fill(`E2E Task ${suffix} v2`)
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await expect(page.locator('tr:visible').filter({ hasText: `E2E Task ${suffix} v2` }).first()).toBeVisible({ timeout: 15_000 })

  // delete requires confirmation
  await page.getByRole('button', { name: 'Delete task' }).first().click()
  await expect(page.getByRole('dialog').getByText(/cannot be undone/i)).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('tr:visible').filter({ hasText: `E2E Task ${suffix} v2` })).toHaveCount(0, { timeout: 15_000 })
})

test('task assignee picker lists AI employees with (AI)', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await login(page)

  // prerequisite: an environment + an AI employee
  const envName = `e2e-env-${suffix}`
  await page.goto('/environments')
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('Environment name').fill(envName)
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('tr', { hasText: envName }).first()).toBeVisible({ timeout: 15_000 })

  const botName = `E2e Bot ${suffix}`
  await page.goto('/employees')
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Full name').fill(botName)
  await page.getByPlaceholder('name@company.com').fill(`e2e-bot-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /AI agent/ }).check()
  await page.getByPlaceholder('Job title').fill('Runner')
  await page.getByRole('button', { name: 'Environment', exact: true }).click()
  await page.getByRole('option', { name: envName }).click()
  await page.getByRole('button', { name: /Save|Create employee/ }).click()
  await expect(page.getByText(/shown only once/i)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()
  await expect(page.locator('tr:visible', { hasText: botName })).toBeVisible({ timeout: 15_000 })

  // tasks: picker shows the bot with (AI)
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(`AI task ${suffix}`)
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await expect(page.getByRole('option', { name: new RegExp(botName) }).first()).toContainText('(AI)')
  await page.getByRole('option', { name: new RegExp(botName) }).first().click()
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  // row shows the bot as assignee
  await expect(page.locator('tr:visible').filter({ hasText: botName }).first()).toBeVisible({ timeout: 15_000 })
})
