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

describe('meta.version (oRPC)', () => {
  it('returns APP_VERSION or dev', async () => {
    const { router, buildServerContext } = await import('../server/utils/orpc')
    const callProc = (path: string[]) => {
      let node: Record<string, unknown> = router as unknown as Record<string, unknown>
      for (const k of path) node = node[k] as Record<string, unknown>
      return (node['~orpc'] as { handler: (o: unknown) => Promise<unknown> }).handler({ input: undefined, context: buildServerContext(new Headers()), signal: new AbortController().signal })
    }
    expect(await callProc(['meta', 'version'])).toEqual({ version: 'dev' })
    process.env.APP_VERSION = '1.2.3'
    expect(await callProc(['meta', 'version'])).toEqual({ version: '1.2.3' })
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

describe('auth.configLive (oRPC, public)', () => {
  async function firstSnapshot() {
    const { router, buildServerContext } = await import('../server/utils/orpc')
    let node: Record<string, unknown> = router as unknown as Record<string, unknown>
    for (const k of ['auth', 'configLive']) node = node[k] as Record<string, unknown>
    const gen = await (node['~orpc'] as { handler: (o: unknown) => Promise<AsyncGenerator<unknown>> }).handler({ input: undefined, context: buildServerContext(new Headers()), signal: new AbortController().signal })
    const first = (await gen.next()).value
    await gen.return?.()
    return first
  }

  it('shows password-only defaults', async () => {
    expect(await firstSnapshot()).toEqual({ passwordEnabled: true, oidcEnabled: false, providers: [], companyName: 'Tandem' })
  })

  it('lists stored providers without secrets', async () => {
    const { saveOidcProviders } = await import('../server/utils/oidc')
    await saveOidcProviders([{ id: 'p1', label: 'SSO', issuer: 'https://sso.example.com', clientId: 'cid', clientSecret: 'shh' }])
    expect(await firstSnapshot()).toEqual({ passwordEnabled: true, oidcEnabled: true, providers: [{ id: 'p1', label: 'SSO' }], companyName: 'Tandem' })
  })
})

describe('oRPC session surface', () => {
  // The auth middleware runs inside RPCHandler — exercise through it.
  async function rpcPost(path: string, headers?: Record<string, string>) {
    const { RPCHandler } = await import('@orpc/server/fetch')
    const { router, buildServerContext } = await import('../server/utils/orpc')
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    const original = inst.api.getSession
    inst.api.getSession = async () => null
    try {
      const handler = new RPCHandler(router)
      const req = new Request(`http://x/rpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ json: null }),
      })
      const { response } = await handler.handle(req, { prefix: '/rpc', context: buildServerContext(new Headers()) })
      return response
    }
    finally {
      inst.api.getSession = original
      void realGetSession
    }
  }

  it('settings.live rejects anonymous calls (401)', async () => {
    const res = await rpcPost('settings/live')
    expect(res!.status).toBe(401)
  })

  it('oidc.live rejects anonymous calls (401)', async () => {
    const res = await rpcPost('oidc/live')
    expect(res!.status).toBe(401)
  })

  it('settings.update rejects anonymous calls (401)', async () => {
    const res = await rpcPost('settings/update')
    expect(res!.status).toBe(401)
  })

  async function proc(path: string[]) {
    const { router, buildServerContext } = await import('../server/utils/orpc')
    let node: Record<string, unknown> = router as unknown as Record<string, unknown>
    for (const k of path) node = node[k] as Record<string, unknown>
    return (node['~orpc'] as { handler: (o: unknown) => Promise<unknown> }).handler({ input: undefined, context: buildServerContext(new Headers()), signal: new AbortController().signal })
  }

  it('auth.session returns null without a cookie', async () => {
    expect(await proc(['auth', 'session'])).toBeNull()
  })

  it('auth.session returns the session for a signed-in user', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const { buildServerContext, router } = await import('../server/utils/orpc')
    const auth = await getAuth()
    await auth.api.signUpEmail({ body: { email: 's@x.co', password: 'password1234', name: 'S' } })
    const signIn = await auth.api.signInEmail({ body: { email: 's@x.co', password: 'password1234' }, asResponse: true })
    const cookie = signIn.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    let node: Record<string, unknown> = router as unknown as Record<string, unknown>
    for (const k of ['auth', 'session']) node = node[k] as Record<string, unknown>
    const res = await (node['~orpc'] as { handler: (o: unknown) => Promise<unknown> }).handler({ input: undefined, context: buildServerContext(new Headers({ cookie })), signal: new AbortController().signal }) as { user: { email: string, role: string } }
    expect(res).toMatchObject({ user: { email: 's@x.co', role: 'admin' } })
  })
})
