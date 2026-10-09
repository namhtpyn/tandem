// API-layer tests: h3 handlers invoked with REAL h3 events (createEvent).
// Covers version, health live/ready, auth-config, session gates.
import { describe, expect, it, beforeEach } from 'vitest'
import './helpers/pg'
import { resetSchema } from './helpers/pg'
import { applyMigrations, sqlClient } from '../server/db/index'
import { createEvent, defineEventHandler, setResponseStatus, setResponseHeader, getResponseHeaders, getRequestHeaders, createError, readBody, readRawBody, getRouterParam } from 'h3'

// ---- harness: real h3 events + nitro auto-import aliases ----

interface FakeReq {
  method: string
  url: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
}

const g = globalThis as Record<string, unknown>
g.defineEventHandler = defineEventHandler
g.defineNitroPlugin = (fn: unknown) => fn
g.createError = createError
g.setRequestHeader = setResponseHeader
g.getResponseHeaders = getResponseHeaders
g.setRequestStatus = setResponseStatus
g.setResponseStatus = setResponseStatus
g.readBody = readBody
g.readRawBody = readRawBody
g.getRouterParam = getRouterParam
g.getRequestHeaders = getRequestHeaders
g.requireSession = (await import('../server/utils/session')).requireSession

function makeEvent(req: FakeReq) {
  const rawBody = req.body === undefined ? undefined : JSON.stringify(req.body)
  const headers: Record<string, string | string[] | undefined> = { ...(req.headers ?? {}) }
  if (rawBody !== undefined) headers['content-type'] = 'application/json'
  const chunks: Buffer[] = rawBody === undefined ? [] : [Buffer.from(rawBody)]
  const nodeReq = {
    headers,
    url: req.url,
    method: req.method,
    on: (ev: string, fn: (chunk: Buffer) => void) => {
      if (ev === 'data') for (const c of chunks) fn(c)
    },
    removeListener: () => {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
  const nodeRes = { statusCode: 200, setHeader: () => {}, end: () => {}, writeHead: () => {}, write: () => {}, on: () => {}, once: () => {} }
  return createEvent(nodeReq as never, nodeRes as never)
}

async function call(modPath: string, req: FakeReq) {
  const mod = await import(modPath)
  const event = makeEvent(req)
  ;(event.node.req as unknown as Record<symbol, unknown>)[Symbol.for('h3ParsedBody')] = req.body ?? {}
  const result = await (mod.default as (e: unknown) => unknown)(event)
  return { result, event }
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  await sqlClient`delete from tandem_user`
})

describe('GET /api/version', () => {
  it('returns APP_VERSION or dev', async () => {
    const { result } = await call('../server/api/version.get.ts', { method: 'GET', url: '/api/version' })
    expect(result).toEqual({ version: 'dev' })
    process.env.APP_VERSION = '1.2.3'
    const again = await call('../server/api/version.get.ts', { method: 'GET', url: '/api/version' })
    expect(again.result).toEqual({ version: '1.2.3' })
    delete process.env.APP_VERSION
  })
})

describe('GET /health/live', () => {
  it('is always ok (200, no DB touch)', async () => {
    const { result, event } = await call('../server/routes/health/live.get.ts', { method: 'GET', url: '/health/live' })
    expect(result).toEqual({ ok: true })
    expect((event.node.res as unknown as { statusCode: number }).statusCode).toBe(200)
  })
})

describe('GET /health/ready', () => {
  it('is ok when the DB answers', async () => {
    const { result } = await call('../server/routes/health/ready.get.ts', { method: 'GET', url: '/health/ready' })
    expect(result).toEqual({ ok: true, migrations: 'complete' })
  })
})

describe('GET /api/auth-config', () => {
  it('shows password-only defaults', async () => {
    const { result } = await call('../server/api/auth-config.get.ts', { method: 'GET', url: '/api/auth-config' })
    expect(result).toEqual({ passwordEnabled: true, oidcEnabled: false, providers: [] })
  })

  it('lists stored providers without secrets', async () => {
    const { saveOidcProviders } = await import('../server/utils/oidc')
    await saveOidcProviders([{ id: 'p1', label: 'SSO', issuer: 'https://sso.example.com', clientId: 'cid', clientSecret: 'shh' }])
    const { result } = await call('../server/api/auth-config.get.ts', { method: 'GET', url: '/api/auth-config' })
    expect(result).toEqual({ passwordEnabled: true, oidcEnabled: true, providers: [{ id: 'p1', label: 'SSO' }] })
  })
})

describe('session gates (401 without a session)', () => {
  it('GET /api/settings', async () => {
    await expect(call('../server/api/settings/index.get.ts', { method: 'GET', url: '/api/settings' }))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('GET /api/oidc', async () => {
    await expect(call('../server/api/oidc/index.get.ts', { method: 'GET', url: '/api/oidc' }))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('PUT /api/settings', async () => {
    await expect(call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: { disablePasswordLogin: true } }))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('GET /api/auth-session returns null without a cookie', async () => {
    const { result } = await call('../server/api/auth-session.get.ts', { method: 'GET', url: '/api/auth-session' })
    expect(result).toBeNull()
  })

  it('GET /api/auth-session returns the session for a signed-in user', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const auth = await getAuth()
    await auth.api.signUpEmail({ body: { email: 's@x.co', password: 'password1234', name: 'S' } })
    const signIn = await auth.api.signInEmail({ body: { email: 's@x.co', password: 'password1234' }, asResponse: true })
    const cookie = signIn.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const { result } = await call('../server/api/auth-session.get.ts', { method: 'GET', url: '/api/auth-session', headers: { cookie } })
    expect(result).toMatchObject({ user: { email: 's@x.co', role: 'admin' } })
  })
})
