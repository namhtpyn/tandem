import { expect, test } from '@playwright/test'

// M2: environments — live CRUD over oRPC /rpc, SSE realtime, probe.

async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin')
  await page.getByPlaceholder('you@company.com').fill('admin@tandem.local')
  await page.getByPlaceholder('••••••••').fill('tandem-admin')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/admin/)
  await expect(page.getByText('Overview')).toBeVisible()
}

test('environment CRUD round-trip on the live page', async ({ page }) => {
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).click()
  await expect(page.getByText('No environments yet')).toBeVisible()

  // create
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('ct112-tandem').fill('e2e-box')
  await page.getByPlaceholder('192.168.3.108').fill('127.0.0.1')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('e2e-box')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/tandem@127\.0\.0\.1:22/)).toBeVisible()

  // duplicate name -> conflict surfaced
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await page.getByPlaceholder('ct112-tandem').fill('e2e-box')
  await page.getByPlaceholder('192.168.3.108').fill('10.0.0.1')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/already exists/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // edit host
  await page.getByRole('button', { name: 'Edit environment' }).click()
  await page.getByPlaceholder('192.168.3.108').fill('10.9.8.7')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/tandem@10\.9\.8\.7:22/)).toBeVisible({ timeout: 15_000 })

  // probe (refused port -> failed badge with detail)
  await page.getByRole('button', { name: 'Edit environment' }).isVisible().catch(() => {})
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('failed').first()).toBeVisible({ timeout: 20_000 })

  // delete
  await page.getByRole('button', { name: 'Delete environment' }).click()
  await expect(page.getByText('No environments yet')).toBeVisible({ timeout: 15_000 })
})

test('live table updates from another tab via SSE', async ({ context, page }) => {
  await login(page)
  await page.getByRole('link', { name: /Environments/ }).click()
  await expect(page.getByText('No environments yet')).toBeVisible()

  const other = await context.newPage()
  await other.goto('/admin/environments')
  await expect(other.getByText('No environments yet')).toBeVisible()

  // create from the other tab; first tab must update without reload
  await other.getByRole('button', { name: 'New environment' }).first().click()
  await other.getByPlaceholder('ct112-tandem').fill('sse-ghost')
  await other.getByPlaceholder('192.168.3.108').fill('127.0.0.1')
  await other.getByRole('button', { name: 'Save' }).click()
  await expect(other.getByText('sse-ghost')).toBeVisible({ timeout: 15_000 })

  await expect(page.getByText('sse-ghost')).toBeVisible({ timeout: 15_000 })

  // cleanup
  await page.getByRole('button', { name: 'Delete environment' }).click()
  await expect(page.getByText('No environments yet')).toBeVisible({ timeout: 15_000 })
  await other.close()
})

test('unauthenticated /rpc rejects with 401', async ({ request }) => {
  const res = await request.post('/rpc/environments/create', {
    headers: { 'content-type': 'application/json' },
    data: { json: { name: 'x', host: 'h', port: '22', username: 'u' } },
  })
  expect(res.status()).toBe(401)
})
