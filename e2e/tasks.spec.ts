import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// visible row/card: desktop tr or the mobile card stack (md:hidden)
const VISIBLE_ROW = 'tr:visible'

test('task CRUD round-trip, assignee badge, status via select', async ({ page }) => {
  const suffix = Date.now().toString(36)
  await login(page)
  await page.goto('/tasks')

  // create via the toolbar button
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(`E2E Task ${suffix}`)
  await page.locator('[contenteditable]').first().fill('created by e2e')
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await page.getByRole('option', { name: 'Admin' }).click()
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await expect(page.locator(VISIBLE_ROW).filter({ hasText: `E2E Task ${suffix}` }).first()).toBeVisible({ timeout: 15_000 })

  // status flip via the inline select (task descriptions no longer render on the list)
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
  await page.getByPlaceholder('hermes acp').fill('hermes acp')
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

test('workflow drawer shows activity and lets the owner answer', async ({ page }) => {
  await login(page)
  const suffix = Date.now().toString(36).slice(-6)
  await page.goto('/tasks')
  // create a task owned by admin
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(`WF ${suffix}`)
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(1200)
  // open the workflow drawer (row-scoped locator: immune to live re-renders of sibling rows)
  const row = page.locator('tr').filter({ hasText: `WF ${suffix}` }).first()
  await row.locator('button[aria-label="Task workflow"]').first().click()
  const drawer = page.locator('[data-slot="content"]').first()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText(/no activity yet/i)).toBeVisible()
  // note + Ask is rejected (admin is not assignee) -> error surfaces
  await drawer.locator('textarea').fill('who owns the spec?')
  await drawer.getByRole('button', { name: 'Ask' }).click()
  await expect(drawer.getByText(/only a task in progress|assignee/i).first()).toBeVisible({ timeout: 10_000 })
})

test('workflow drawer streams an agent run to completion', async ({ page }) => {
  await login(page)
  const suffix = Date.now().toString(36)
  const envName = `e2e-runenv-${suffix}`
  const botName = `E2e Runner ${suffix}`
  // prerequisite: environment + AI employee
  await page.goto('/environments')
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('Environment name').fill(envName)
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('tr', { hasText: envName }).first()).toBeVisible({ timeout: 15_000 })
  await page.goto('/employees')
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Full name').fill(botName)
  await page.getByPlaceholder('name@company.com').fill(`e2e-runner-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /AI agent/ }).check()
  await page.getByPlaceholder('hermes acp').fill('hermes acp')
  await page.getByPlaceholder('Job title').fill('Runner')
  await page.getByRole('button', { name: 'Environment', exact: true }).click()
  await page.getByRole('option', { name: envName }).click()
  await page.getByRole('button', { name: /Save|Create employee/ }).click()
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()
  await page.goto('/tasks')
  // create a task assigned to the AI employee
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(`Run ${suffix}`)
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await page.getByRole('option', { name: new RegExp(botName) }).first().click()
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(1500)
  // open the workflow drawer (row-scoped locator)
  const row = page.locator('tr').filter({ hasText: `Run ${suffix}` }).first()
  await row.locator('button[aria-label="Task workflow"]').first().click()
  const drawer = page.locator('[data-slot="content"]').first()
  await expect(drawer).toBeVisible()
  // the auto-dispatcher (fake runner) picks the ready task up and streams output
  await expect(drawer.getByText(/RESULT: task complete/i)).toBeVisible({ timeout: 30_000 })
  // the run card reports done + exit 0
  await expect(drawer.getByText(/done · exit 0/i)).toBeVisible()
  // the activity feed logs dispatch; the run card's status pill is the verdict
  await expect(drawer.getByText(/dispatched to/i).first()).toBeVisible()
  await expect(drawer.getByText(/done/i).first()).toBeVisible()
})
