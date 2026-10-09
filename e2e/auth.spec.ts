// E2E: boot, health, login flow, auth-gated admin, OIDC settings round-trip.
// Runs against a built server (bun .output/server/index.mjs) on :4100 with its
// own database tandem_e2e.
import { expect, test } from '@playwright/test'

test.describe('health', () => {
  test('live is always 200', async ({ request }) => {
    const res = await request.get('/health/live')
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('ready reports migrations complete', async ({ request }) => {
    const res = await request.get('/health/ready')
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ ok: true, migrations: 'complete' })
  })
})

test.describe('auth flow', () => {
  test('root redirects to /admin', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/admin/)
  })

  test('admin page shows the login form before authentication', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('wrong password is rejected', async ({ page }) => {
    await page.goto('/admin')
    await page.getByLabel(/email/i).fill('admin@tandem.local')
    await page.getByLabel(/password/i).fill('not-the-password')
    await page.getByRole('button', { name: /sign in/i }).click()
    // stays on login (no dashboard shell)
    await expect(page.getByLabel(/password/i)).toBeVisible()
  })

  test('admin login lands on the dashboard and shows the session', async ({ page }) => {
    await page.goto('/admin')
    await page.getByLabel(/email/i).fill('admin@tandem.local')
    await page.getByLabel(/password/i).fill('tandem-admin')
    await page.getByRole('button', { name: /sign in/i }).click()
    // dashboard shell appears: user chip (avatar initials + name + role) replaces the login card
    await expect(page.getByText('Overview').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('admin', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0)
  })

  test('unauthenticated API access is 401', async ({ request }) => {
    const res = await request.get('/api/settings')
    expect(res.status()).toBe(401)
  })

  test('auth-config is public and password-only by default', async ({ request }) => {
    const res = await request.get('/api/auth-config')
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ passwordEnabled: true, oidcEnabled: false, providers: [] })
  })
})

test.describe('authenticated settings', () => {
  test.use({ storageState: undefined })

  test('signed-in admin can read settings and manage OIDC providers', async ({ page, request }) => {
    // sign in via UI to get the session cookie in the browser context
    await page.goto('/admin')
    await page.getByLabel(/email/i).fill('admin@tandem.local')
    await page.getByLabel(/password/i).fill('tandem-admin')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText('Overview').first()).toBeVisible({ timeout: 15_000 })

    // settings API through the browser (carries the cookie)
    const settings = await page.request.get('/api/settings')
    expect(settings.status()).toBe(200)
    expect(await settings.json()).toEqual({ disablePasswordLogin: false })

    // add an OIDC provider via the API
    const put = await page.request.put('/api/oidc', {
      data: { providers: [{ label: 'E2E SSO', issuer: 'https://sso.example.com', clientId: 'e2e-client', clientSecret: 'e2e-secret' }] },
    })
    expect(put.status()).toBe(200)
    expect(await put.json()).toEqual({ ok: true, count: 1 })

    // public auth-config now lists it (without the secret)
    const cfg = await request.get('/api/auth-config')
    expect(await cfg.json()).toMatchObject({ oidcEnabled: true, providers: [{ label: 'E2E SSO' }] })

    // disabling password login is allowed now (provider exists)
    const dis = await page.request.put('/api/settings', { data: { disablePasswordLogin: true } })
    expect(dis.status()).toBe(200)

    // restore
    await page.request.put('/api/settings', { data: { disablePasswordLogin: false } })
    await page.request.put('/api/oidc', { data: { providers: [] } })
  })

  test('version endpoint reports the build version', async ({ request }) => {
    const res = await request.get('/api/version')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.version).toBe('string')
    expect(body.version.length).toBeGreaterThan(0)
  })
})
