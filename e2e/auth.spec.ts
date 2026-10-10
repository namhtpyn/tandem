// E2E: boot, health, login flow, auth-gated admin, OIDC settings round-trip.
// Runs against a built server (bun .output/server/index.mjs) on :4100 with its
// own database tandem_e2e.
import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

/** POST an oRPC live procedure, read the FIRST SSE data event, abort the
 * stream. Never await the full body — live streams never end. */
async function readFirstSseData(_request: import('@playwright/test').APIRequestContext, path: string, cookie?: string): Promise<any> {
  const base = process.env.TANDEM_E2E_URL || 'http://localhost:4100'
  const ac = new AbortController()
  try {
    const streaming = await fetch(new URL(path, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ json: null }),
      signal: ac.signal,
    })
    if (streaming.status !== 200) throw new Error(`${path} -> ${streaming.status}`)
    const reader = streaming.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const { value } = await reader.read()
      buffer += decoder.decode(value!, { stream: true })
      const m = /data:(.+)/.exec(buffer)
      if (m) {
        const parsed = JSON.parse(m[1]!.trim())
        // oRPC envelope: { json: <snapshot> }
        return parsed?.json ?? parsed
      }
    }
    throw new Error(`no SSE data event within deadline: ${path}`)
  }
  finally {
    ac.abort()
  }
}

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
  test('root serves the app', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/$/)
  })

  test('admin page shows the login form before authentication', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('wrong password is rejected', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel(/email/i).fill('admin@tandem.local')
    await page.getByLabel(/password/i).fill('not-the-password')
    await page.getByRole('button', { name: /sign in/i }).click()
    // stays on login (no dashboard shell)
    await expect(page.getByLabel(/password/i)).toBeVisible()
  })

  test('admin login lands on the dashboard and shows the session', async ({ page }) => {
    // hydration-safe login (raw fill+click races Vue hydration under load)
    await login(page)
    await expect(page.getByText('admin', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0)
  })

  test('unauthenticated oRPC call is 401', async ({ request }) => {
    const res = await request.post('/rpc/settings/live', { headers: { 'content-type': 'application/json' }, data: { json: null } })
    expect(res.status()).toBe(401)
  })

  test('auth.configLive is public and password-only by default', async ({ request }) => {
    // SSE stream: read the FIRST data event, then abort — never await the body
    const body = await readFirstSseData(request, '/rpc/auth/configLive')
    expect(body).toEqual({ passwordEnabled: true, oidcEnabled: false, providers: [] })
  })
})

test.describe('authenticated settings', () => {
  test.use({ storageState: undefined })

  test('signed-in admin can read settings and manage OIDC providers', async ({ page, request }) => {
    // sign in via UI (hydration-safe) to get the session cookie in the browser context
    await login(page)

    const cookies = await page.context().cookies()
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

    try {
      // settings via oRPC with the browser cookie (SSE: first event only)
      const settings = await readFirstSseData(request, '/rpc/settings/live', cookieHeader)
      expect(settings).toEqual({ disablePasswordLogin: false })

      // add an OIDC provider via oRPC
      const put = await request.post('/rpc/oidc/replace', {
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        data: { json: { providers: [{ label: 'E2E SSO', issuer: 'https://sso.example.com', clientId: 'e2e-client', clientSecret: 'e2e-secret' }] } },
      })
      expect(put.status()).toBe(200)
      expect(await put.json()).toMatchObject({ json: { ok: true, count: 1 } })

      // public auth.configLive now lists it (without the secret)
      const cfg = await readFirstSseData(request, '/rpc/auth/configLive')
      expect(cfg).toMatchObject({ oidcEnabled: true, providers: [{ label: 'E2E SSO' }] })

      // disabling password login is allowed now (provider exists)
      const dis = await request.post('/rpc/settings/update', {
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        data: { json: { disablePasswordLogin: true } },
      })
      expect(dis.status()).toBe(200)
    }
    finally {
      // ALWAYS restore — a leaked disablePasswordLogin=true breaks every later test
      await request.post('/rpc/settings/update', {
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        data: { json: { disablePasswordLogin: false } },
      }).catch(() => {})
      await request.post('/rpc/oidc/replace', {
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        data: { json: { providers: [] } },
      }).catch(() => {})
    }
  })

  test('meta.version reports the build version', async ({ request }) => {
    const res = await request.post('/rpc/meta/version', { headers: { 'content-type': 'application/json' }, data: { json: null } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(typeof body.json.version).toBe('string')
    expect(body.json.version.length).toBeGreaterThan(0)
  })
})
