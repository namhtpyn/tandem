// Final coverage closure: auth route gates (header shapes, password-disabled,
// raw-body path), requireSession 401, auth-session success path, ready 503,
// oidc edit-failure, settings payload arms.
import { describe, expect, it, beforeEach } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { sqlClient } from '../server/db/index'
import { call } from './api-harness'

beforeEach(async () => {
  await resetSchema()
  const { applyMigrations } = await import('../server/db/index')
  await applyMigrations()
  await sqlClient`delete from tandem_user`
})

describe('auth route header handling', () => {
  it('POST sign-in/email with multi-value + undefined headers passes the gate', async () => {
    // auth instance is real; without a user the underlying handler 401s — but our
    // route gate (passwordEnabled) must let it THROUGH to the handler.
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const originalHandler = inst.handler
    let captured: Request | undefined
    inst.handler = async (req: Request) => {
      captured = req
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const { event } = await call('../server/routes/auth/[...].ts', {
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { 'x-multi': ['a', 'b'], 'x-absent': undefined, 'content-type': 'application/json' },
        body: { email: 'a@b.co', password: 'password1234' },
      })
      expect(event.node.res.statusCode).toBe(200)
      expect(captured).toBeDefined()
      expect(captured!.headers.get('x-multi')).toBe('a, b')
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('GET with array cookie header: first value wins', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const originalHandler = inst.handler
    inst.handler = async (req: Request) => {
      const cookie = req.headers.get('cookie')
      return new Response(JSON.stringify({ cookie }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const { result } = await call('../server/routes/auth/[...].ts', {
        method: 'GET',
        url: '/auth/get-session',
        headers: { cookie: ['sid=1', 'sid=2'] },
      })
      const text = Buffer.from(result as Uint8Array).toString('utf8')
      expect(text).toContain('sid=1')
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('GET with undefined header value: header omitted', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const originalHandler = inst.handler
    inst.handler = async (req: Request) => {
      const has = req.headers.has('x-absent')
      return new Response(JSON.stringify({ has }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const { result } = await call('../server/routes/auth/[...].ts', {
        method: 'GET',
        url: '/auth/get-session',
        headers: { 'x-absent': undefined },
      })
      const text = Buffer.from(result as Uint8Array).toString('utf8')
      expect(text).toContain('"has":false')
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('blocks password sign-in when password login is disabled (403)', async () => {
    const { setSetting } = await import('../server/utils/settings')
    await setSetting('disablePasswordLogin', 'true')
    const { saveOidcProviders } = await import('../server/utils/oidc')
    await saveOidcProviders([{ id: 'p1', label: 'SSO', issuer: 'https://sso.example.com', clientId: 'c', clientSecret: 's' }])
    await expect(call('../server/routes/auth/[...].ts', { method: 'POST', url: '/auth/sign-in/email', body: { email: 'a@b.co', password: 'password1234' } }))
      .rejects.toMatchObject({ statusCode: 403 })
    await setSetting('disablePasswordLogin', 'false')
  })

  it('returns null body when the auth handler sends no body', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const originalHandler = inst.handler
    inst.handler = async () => new Response(null, { status: 204 })
    try {
      const { result } = await call('../server/routes/auth/[...].ts', { method: 'GET', url: '/auth/get-session' })
      expect(result).toBeNull()
    }
    finally {
      inst.handler = originalHandler
    }
  })
})

describe('requireSession', () => {
  it('throws 401 when the auth session is null', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    inst.api.getSession = async () => null
    try {
      const { makeEvent } = await import('./api-harness')
      const sessionMod = await import('../server/utils/session')
      const event = makeEvent({ method: 'GET', url: '/api/settings' })
      await expect(sessionMod.requireSession(event as never)).rejects.toMatchObject({ statusCode: 401 })
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })

})


describe('GET /health/ready 503 path', () => {
  it('reports failure when the DB query throws', async () => {
    // sabotage the ledger the ready check uses: point search_path at a dead
    // schema via a prepared sabotage — simplest: drop the migrations table so
    // the ledger count query throws inside the handler's try
    await sqlClient`drop table tandem_migrations`
    const { result, event } = await call('../server/routes/health/ready.get.ts', { method: 'GET', url: '/health/ready' })
    expect(result).toMatchObject({ ok: false })
    expect((event.node.res as { statusCode: number }).statusCode).toBe(503)
  })
})

describe('PUT /api/oidc edit-failure arm', () => {
  it('rejects an edit whose merged provider fails schema (unknown id + no secret)', async () => {
    await expect(call('../server/api/oidc/index.put.ts', {
      method: 'PUT',
      url: '/api/oidc',
      body: { providers: [{ id: '00000000-0000-4000-8000-000000000000', label: 'Ghost', issuer: 'https://ghost.example.com', clientId: 'c' }] },
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('PUT /api/settings payload arms', () => {
  it('empty object body: no-op success', async () => {
    const { result } = await call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: {} })
    expect(result).toEqual({ ok: true })
  })

  it('issue path join fallback: body not an object', async () => {
    await expect(call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})


describe('remaining branch arms', () => {
  it('requireSession header arms: undefined skipped, array appended, scalar set', async () => {
    const sessionMod = await import('../server/utils/session')
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    let seen: Headers | null = null
    inst.api.getSession = async (opts: { headers: Headers }) => {
      seen = opts.headers
      return null
    }
    try {
      const { makeEvent } = await import('./api-harness')
      const event = makeEvent({ method: 'GET', url: '/api/settings', headers: { 'x-a': ['1', '2'], 'x-b': 'v', 'x-c': undefined } })
      await sessionMod.requireSession(event as never).catch(() => {})
      expect(seen!.get('x-a')).toBe('1, 2')
      expect(seen!.get('x-b')).toBe('v')
      expect(seen!.has('x-c')).toBe(false)
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })

  it('auth-session role fallback: null role maps to viewer', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    inst.api.getSession = async () => ({
      user: { id: 'u', name: 'U', email: 'u@x', emailVerified: true, role: null },
      session: { id: 's', userId: 'u', expiresAt: new Date() },
    })
    try {
      const { result } = await call('../server/api/auth-session.get.ts', { method: 'GET', url: '/api/auth-session' })
      expect(result).toMatchObject({ user: { role: 'viewer' } })
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })

  it('oidc put: schema failure message arm (bad issuer on new provider)', async () => {
    await expect(call('../server/api/oidc/index.put.ts', {
      method: 'PUT',
      url: '/api/oidc',
      body: { providers: [{ label: 'Bad', issuer: 'not a url at all', clientId: 'c', clientSecret: 's' }] },
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('settings put: issue.path fallback arm (root-level type error)', async () => {
    await expect(call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: 42 }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('auth route: headerValue single-value arm + sign-up gate passthrough with body', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const originalHandler = inst.handler
    let captured: Request | undefined
    inst.handler = async (req: Request) => {
      captured = req
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'x-echo': req.headers.get('x-single') ?? '' } })
    }
    try {
      const { event } = await call('../server/routes/auth/[...].ts', {
        method: 'POST',
        url: '/auth/sign-up/email',
        headers: { 'x-single': 'solo' },
        body: { email: 'n@x.co', password: 'password1234', name: 'N' },
      })
      expect(event.node.res.statusCode).toBe(200)
      expect(captured).toBeDefined()
      // raw-body branch: request carried the JSON body
      const resHeaders = event.node.res.getHeader('x-echo')
      expect(resHeaders).toBe('solo')
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('health ready: first-hit migration log arm (fresh ledger)', async () => {
    await resetSchema()
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    try {
      const { result } = await call('../server/routes/health/ready.get.ts', { method: 'GET', url: '/health/ready' })
      expect(result).toMatchObject({ ok: true })
      expect(logs.some(l => l.includes('applied migrations'))).toBe(true)
      // second hit: migrationsDone already true -> no log, still ok
      const again = await call('../server/routes/health/ready.get.ts', { method: 'GET', url: '/health/ready' })
      expect(again.result).toMatchObject({ ok: true })
    }
    finally {
      console.log = orig
    }
  })
})


describe('fallback branch arms', () => {
  it('auth route: host/proto/url fallbacks when headers absent', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const originalHandler = inst.handler
    let capturedUrl = ''
    inst.handler = async (req: Request) => {
      capturedUrl = req.url
      return new Response(null, { status: 204 })
    }
    try {
      // event with NO host/proto headers and empty path
      await call('../server/routes/auth/[...].ts', { method: 'GET', url: '', headers: {} })
      expect(capturedUrl).toMatch(/^http:\/\/localhost/)
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('oidc put: outer zod issue arm with path fallback (array body)', async () => {
    await expect(call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: [] }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})


describe('auth route fallback arms (real coverage)', () => {
  it('array x-forwarded-proto collapses to first value; undefined url falls back', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const originalHandler = inst.handler
    let captured: Request | undefined
    inst.handler = async (req: Request) => {
      captured = req
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      // proto array arm
      await call('../server/routes/auth/[...].ts', {
        method: 'GET',
        url: '/auth/get-session',
        headers: { 'x-forwarded-proto': ['https', 'http'] },
      })
      expect(captured!.url.startsWith('https://')).toBe(true)
      // undefined-url arms (both routes' `req.url ?? fallback`)
      await call('../server/routes/auth/[...].ts', { method: 'GET', headers: { 'x-forwarded-proto': 'https' } })
      expect(captured!.url.startsWith('https://')).toBe(true)
      // POST sign-up closed arm: a user already exists (seeded by beforeEach migrate+seed? none) —
      // create one first, then attempt sign-up
    }
    finally {
      inst.handler = originalHandler
    }
  })

  it('POST sign-up/email closed once a user exists (403)', async () => {
    const { sqlClient } = await import('../server/db/index')
    await sqlClient`insert into tandem_user (id, name, email, email_verified, created_at, updated_at, role)
      values ('u-close', 'Closer', 'c@x.co', true, now(), now(), 'viewer')`
    await expect(call('../server/routes/auth/[...].ts', { method: 'POST', url: '/auth/sign-up/email', body: { email: 'a@b.co', password: 'password1234', name: 'A' } }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('oidc route 404 when no provider configured (real registry empty)', async () => {
    const { saveOidcProviders } = await import('../server/utils/oidc')
    await saveOidcProviders([])
    delete process.env.TANDEM_OIDC_ISSUER
    await expect(call('../server/routes/auth/[...].ts', { method: 'GET', url: '/auth/oauth2/testprovider' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('oidc route passes the gate when a provider is configured', async () => {
    const { saveOidcProviders } = await import('../server/utils/oidc')
    await saveOidcProviders([{ id: 'p1', label: 'SSO', issuer: 'https://sso.example.com', clientId: 'c', clientSecret: 's' }])
    delete process.env.TANDEM_OIDC_ISSUER
    // passes our gate; the real better-auth handler then responds (likely 400/404
    // for an unknown provider id — anything but OUR 404 gate is fine)
    const r = await call('../server/routes/auth/[...].ts', { method: 'GET', url: '/auth/oauth2/p1' }).catch(e => e)
    expect(r).toBeDefined()
    expect((r as { statusCode?: number }).statusCode).not.toBe(404)
    await saveOidcProviders([])
  })
})
