// Shared harness for authenticated API tests: real h3 events + vitest-mocked session.
import { vi } from 'vitest'
import { createEvent, defineEventHandler, setResponseStatus, setResponseHeader, getResponseHeaders, getRequestHeaders, createError, readBody, readRawBody, getRouterParam, toWebRequest } from 'h3'

// Keep the REAL requireSession and the REAL auth singleton; stub only
// getSession on the singleton's api so internal guards see the test admin while
// auth-route handler swaps keep working (same object identity).
vi.mock('../server/utils/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/utils/auth')>()
  let singleton: Awaited<ReturnType<typeof actual.getAuth>> | null = null
  const originalGetAuth = actual.getAuth
  const wrappedGetAuth = async () => {
    if (!singleton) {
      singleton = await originalGetAuth()
      const realApi = singleton.api
      Object.defineProperty(singleton, 'api', {
        value: {
          ...realApi,
          getSession: async () => ({
            user: { id: 'test-admin', name: 'Test Admin', email: 'test@tandem.local', emailVerified: true, role: 'admin' },
            session: { id: 'test-session', userId: 'test-admin', expiresAt: new Date(Date.now() + 3600_000) },
          }),
        },
        writable: true,
        configurable: true,
      })
    }
    return singleton
  }
  return { ...actual, getAuth: wrappedGetAuth, __resetAuthSingleton: () => { singleton = null } }
})

export interface FakeReq {
  method: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
}

const g = globalThis as Record<string, unknown>
g.defineEventHandler = defineEventHandler
g.defineNitroPlugin = (fn: unknown) => fn
g.createError = createError
g.setRequestHeader = setResponseHeader
g.setResponseHeader = setResponseHeader
g.getResponseHeaders = getResponseHeaders
g.setRequestStatus = setResponseStatus
g.setResponseStatus = setResponseStatus
g.readBody = readBody
g.readRawBody = readRawBody
g.getRouterParam = getRouterParam
g.toWebRequest = toWebRequest
g.getRequestHeaders = getRequestHeaders
// EventEmitter-lite node req: buffered body chunks are delivered on resume/end
// wiring so h3's stream-based readRawBody sees the full body.
class FakeNodeReq {
  headers: Record<string, string | string[] | undefined>
  url: string
  method: string
  body?: unknown
  private chunks: Buffer[]
  private listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  private pumped = false
  constructor(headers: Record<string, string | string[] | undefined>, url: string, method: string, body?: unknown) {
    this.headers = headers
    this.url = url as string
    this.method = method
    this.body = body
    this.chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  }
  on(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ??= []).push(fn); this.kick(); return this }
  once(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ??= []).push(fn); this.kick(); return this }
  removeListener(ev: string, fn: (...a: unknown[]) => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter(f => f !== fn)
    return this
  }
  emit(ev: string, ...args: unknown[]) { for (const fn of [...(this.listeners[ev] ?? [])]) fn(...args) }
  resume() { this.kick() }
  private kick() {
    if (this.pumped) return
    this.pumped = true
    setImmediate(() => {
      for (const c of this.chunks) this.emit('data', c)
      this.emit('end')
    })
  }
  async *[Symbol.asyncIterator]() { for (const c of this.chunks) yield c }
}

export function makeEvent(req: FakeReq) {
  const rawBody = req.body === undefined ? undefined : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
  const headers: Record<string, string | string[] | undefined> = { ...(req.headers ?? {}) }
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(Buffer.byteLength(rawBody))
  }
  const nodeReq = new FakeNodeReq(headers, req.url, req.method, req.body)
  const headerStore: Record<string, string> = {}
  const nodeRes = {
    statusCode: 200,
    getHeader: (k: string) => headerStore[k.toLowerCase()],
    setHeader: (k: string, v: string) => { headerStore[k.toLowerCase()] = String(v) },
    getHeaders: () => headerStore,
    end: () => {},
    writeHead: () => {},
    write: () => {},
    on: () => {},
    once: () => {},
  }
  const event = createEvent(nodeReq as never, nodeRes as never)
  // [id] routes: nitro populates context.params from the matched route; emulate
  // by extracting the trailing uuid segment from the url.
  const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(req.url ?? '')
  if (m) {
    ;(event.context as Record<string, unknown>).params = { id: m[1] }
  }
  return event
}

export async function call(modPath: string, req: FakeReq) {
  const mod = await import(modPath)
  const event = makeEvent(req)
  ;(event.node.req as unknown as Record<symbol, unknown>)[Symbol.for('h3ParsedBody')] = req.body ?? {}
  const result = await (mod.default as (e: unknown) => unknown)(event)
  return { result, event }
}

// Seed h3 router params for [id]-style routes: derive `id` from the url tail.
export function withRouterParam(event: { context: Record<string, unknown> }, params: Record<string, string>) {
  event.context.params = params
  return event
}
