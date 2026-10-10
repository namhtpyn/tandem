import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// M2: environments — live CRUD over oRPC /rpc, SSE realtime, probe.

test('environment CRUD round-trip on the live page', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const rowName = `e2e-box-${suffix}`
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).click()
  await expect(page.getByText('No environments yet')).toBeVisible()

  // create
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('ct112-tandem').fill(rowName)
  await page.getByPlaceholder('192.168.3.108').fill('127.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(rowName)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/tandem@127\.0\.0\.1:22/).first()).toBeVisible()

  // duplicate name -> conflict surfaced (single error node: page one is hidden while modal open)
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('ct112-tandem').fill(rowName)
  await page.getByPlaceholder('192.168.3.108').fill('10.0.0.1')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/already exists/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // edit host (scoped to this row — leftover rows from other specs exist)
  const row = page.locator('tr', { hasText: rowName })
  await row.getByRole('button', { name: 'Edit environment' }).click()
  await page.getByPlaceholder('192.168.3.108').fill('10.9.8.7')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/tandem@10\.9\.8\.7:22/).first()).toBeVisible({ timeout: 15_000 })

  // probe (refused port -> failed badge with detail), scoped to the row
  await row.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('failed').first()).toBeVisible({ timeout: 20_000 })

  // delete (scoped to this row)
  await page.locator('tr', { hasText: rowName }).getByRole('button', { name: 'Delete environment' }).click()
  await expect(page.getByText(rowName)).toHaveCount(0, { timeout: 15_000 })
})

test('live table updates from another tab via SSE', async ({ context, page }) => {
  const suffix = Date.now().toString(36)
  const rowName = `sse-ghost-${suffix}`
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).click()
  await expect(page.getByText('No environments yet')).toBeVisible()

  const other = await context.newPage()
  await other.goto('/admin/environments')
  await expect(other.getByText('No environments yet')).toBeVisible()

  // create from the other tab; first tab must update without reload
  await other.getByRole('button', { name: 'New environment' }).first().click()
  await other.getByPlaceholder('ct112-tandem').fill(rowName)
  await other.getByPlaceholder('192.168.3.108').fill('127.0.0.1')
  await other.getByRole('textbox', { name: 'Username', exact: true }).fill('tandem')
  await other.getByRole('button', { name: 'Save' }).click()
  await expect(other.getByText(rowName)).toBeVisible({ timeout: 15_000 })

  await expect(page.getByText(rowName)).toBeVisible({ timeout: 15_000 })

  // cleanup (scoped to this row)
  await page.locator('tr', { hasText: rowName }).getByRole('button', { name: 'Delete environment' }).click()
  await expect(page.getByText(rowName)).toHaveCount(0, { timeout: 15_000 })
  await other.close()
})

test('unauthenticated /rpc rejects with 401', async ({ request }) => {
  const res = await request.post('/rpc/environments/create', {
    headers: { 'content-type': 'application/json' },
    data: { json: { name: 'x', host: 'h', port: '22', username: 'u' } },
  })
  expect(res.status()).toBe(401)
})
