import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// M2: environments — live CRUD over oRPC /rpc, SSE realtime, probe.

test('environment links a vault secret and shows it in the row', async ({ page }) => {
  await login(page)
  // create a secret first
  await page.goto('/vault')
  const secName = `e2e-env-key-${process.pid}-${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'New secret' }).first().click()
  await page.getByRole('textbox', { name: 'Name' }).fill(secName)
  await page.getByRole('textbox', { name: 'Value' }).fill('e2e-key-material')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('tr:visible', { hasText: secName })).toBeVisible({ timeout: 15_000 })

  // create an environment linked to it
  await page.goto('/environments')
  const envName = `e2e-secret-box-${process.pid}-${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(envName)
  await page.getByRole('textbox', { name: 'Host' }).fill('10.9.8.7')
  await page.getByRole('textbox', { name: 'Username' }).fill('tandem')
  await page.getByLabel('Secret').click()
  await page.getByRole('option', { name: new RegExp(secName) }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('tr:visible', { hasText: envName })).toBeVisible({ timeout: 15_000 })

  // edit shows the linked key preselected
  await page.locator('tr:visible', { hasText: envName }).getByRole('button', { name: 'Edit environment' }).click()
  await expect(page.getByLabel('Secret')).toContainText(secName.slice(0, 20))
  await page.keyboard.press('Escape')

  // cleanup env
  await page.locator('tr:visible', { hasText: envName }).getByRole('button', { name: 'Delete environment' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('tr:visible', { hasText: envName })).toHaveCount(0, { timeout: 15_000 })
})

test('environment CRUD round-trip on the live page', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const rowName = `e2e-box-${suffix}`
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).click()
  await expect(page.getByText('No environments yet')).toBeVisible()

  // create
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('Environment name').fill(rowName)
  await page.getByPlaceholder('Hostname or IP').fill('127.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('tr:visible', { hasText: rowName })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('tr:visible', { hasText: rowName }).locator('span:visible', { hasText: '127.0.0.1' })).toBeVisible()

  // duplicate name -> conflict surfaced (single error node: page one is hidden while modal open)
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('Environment name').fill(rowName)
  await page.getByPlaceholder('Hostname or IP').fill('10.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/already exists/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // edit host (scoped to this row — leftover rows from other specs exist)
  const row = page.locator('tr', { hasText: rowName })
  await row.getByRole('button', { name: 'Edit environment' }).click()
  await page.getByPlaceholder('Hostname or IP').fill('10.9.8.7')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('tr:visible', { hasText: rowName }).locator('span:visible', { hasText: '10.9.8.7' })).toBeVisible({ timeout: 15_000 })

  // probe (refused port -> failed badge with detail), scoped to the row
  await row.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.locator('tr:visible', { hasText: rowName }).getByText('failed')).toBeVisible({ timeout: 20_000 })

  // delete requires confirmation, scoped to this row
  await page.locator('tr:visible', { hasText: rowName }).getByRole('button', { name: 'Delete environment' }).click()
  await expect(page.getByRole('heading', { name: 'Delete environment' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('tr', { hasText: rowName })).toHaveCount(0, { timeout: 15_000 })
})

test('live table updates from another tab via SSE', async ({ context, page }) => {
  const suffix = Date.now().toString(36)
  const rowName = `sse-ghost-${suffix}`
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).first().click()
  await expect(page.getByRole('heading', { name: /Environments/ })).toBeVisible()

  const other = await context.newPage()
  await other.goto('/environments')
  await expect(other.getByRole('heading', { name: /Environments/ })).toBeVisible()

  // create from the other tab; first tab must update without reload
  await other.getByRole('button', { name: 'New environment' }).first().click()
  await other.getByPlaceholder('Environment name').fill(rowName)
  await other.getByPlaceholder('Hostname or IP').fill('127.0.0.1')
  await other.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await other.getByRole('button', { name: 'Save' }).click()
  await expect(other.locator('tr', { hasText: rowName })).toBeVisible({ timeout: 15_000 })

  await expect(page.locator('tr:visible', { hasText: rowName })).toBeVisible({ timeout: 15_000 })

  // cleanup (scoped to this row, with confirmation)
  await page.locator('tr:visible', { hasText: rowName }).getByRole('button', { name: 'Delete environment' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('tr', { hasText: rowName })).toHaveCount(0, { timeout: 15_000 })
  await other.close()
})

test('unauthenticated /rpc rejects with 401', async ({ request }) => {
  const res = await request.post('/rpc/environments/create', {
    headers: { 'content-type': 'application/json' },
    data: { json: { name: 'x', host: 'h', port: '22', username: 'u' } },
  })
  expect(res.status()).toBe(401)
})
