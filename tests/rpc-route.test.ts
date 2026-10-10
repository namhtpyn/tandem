// /rpc route adapter tests: header forwarding (scalar/array/undefined), method,
// SSE live streaming shape, 404 for unknown paths. RPCHandler end-to-end with
// the real router; auth stubbed at the auth-instance level.
import { describe, expect, it, beforeEach } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { makeEvent } from './api-harness'
import { RPCHandler } from '@orpc/server/fetch'
import { router, buildServerContext } from '../server/utils/orpc'

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

async function rpc(event2: ReturnType<typeof makeEvent>, body?: unknown) {
  const headers = new Headers()
  Object.entries(event2.node.req.headers).forEach(([k, v]) => {
    if (v === undefined) return
    if (Array.isArray(v)) v.forEach(item => headers.append(k, item))
    else headers.set(k, String(v))
  })
  const url = new URL(event2.node.req.url ?? '/', 'http://localhost')
  // oRPC RPCHandler wire format: { json: input } envelope
  if (body !== undefined) headers.set('content-type', 'application/json')
  const request = new Request(url, {
    method: event2.method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify({ json: body }) } : {}),
  })
  const handler = new RPCHandler(router)
  const { response } = await handler.handle(request, {
    prefix: '/rpc',
    context: buildServerContext(headers),
  })
  return response ?? new Response('Not Found', { status: 404 })
}

const valid = { name: 'ct112', host: '192.168.3.108', port: '22', username: 'tandem' }

describe('POST /rpc/environments/create', () => {
  it('creates through the full HTTP adapter path (harness session)', async () => {
    const res = await rpc(makeEvent({ method: 'POST', url: '/rpc/environments/create' }), valid)
    expect(res.status).toBe(200)
    const body = await res.json() as { json: { name: string } }
    expect(body.json.name).toBe('ct112')
  })

  it('rejects invalid input (400 path)', async () => {
    const res = await rpc(makeEvent({ method: 'POST', url: '/rpc/environments/create' }), { ...valid, port: 'nope' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('rejects unknown keys (strict schema)', async () => {
    const res = await rpc(makeEvent({ method: 'POST', url: '/rpc/environments/create' }), { ...valid, extra: 1 })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('POST /rpc/environments/live (SSE)', () => {
  it('streams text/event-stream with a JSON snapshot event', async () => {
    const res = await rpc(makeEvent({ method: 'POST', url: '/rpc/environments/live', headers: { accept: 'application/event-stream' } }), undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    let text = ''
    const deadline = Date.now() + 3_000
    while (!text.includes('data:') && Date.now() < deadline) {
      const { value } = await reader.read()
      text += new TextDecoder().decode(value!)
    }
    expect(text).toContain('data:')
    await reader.cancel()
  })
})

describe('unknown procedure', () => {
  it('404s outside the router', async () => {
    const res = await rpc(makeEvent({ method: 'POST', url: '/rpc/nope/nothing' }), {})
    expect(res.status).toBe(404)
  })
})

describe('the /rpc h3 route handler (real adapter)', () => {
  it('onError interceptor logs procedure failures', async () => {
    const errors: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
    try {
      const mod = await import('../server/routes/rpc/[...]')
      const event = makeEvent({ method: 'POST', url: '/rpc/environments/create', headers: { 'content-type': 'application/json' } })
      ;(event.node.req as { body?: unknown }).body = JSON.stringify({ json: { name: '', host: 'h', port: '22', username: 'u' } }) // invalid: name min 1
      const res = await mod.default(event)
      expect((res as Response).status).toBe(400) // validation error -> interceptor
      expect(errors.some(e => e.includes('[orpc]'))).toBe(true)
    }
    finally {
      console.error = orig
    }
  })

  it('forwards node headers (incl. arrays/undefined) and returns the RPC response', async () => {
    const mod = await import('../server/routes/rpc/[...]')
    const handler = mod.default
    const event = makeEvent({
      method: 'POST',
      url: '/rpc/environments/create',
      headers: { 'x-multi': ['a', 'b'], 'x-skip': undefined, cookie: 'sid=test', 'content-type': 'application/json' },
    })
    ;(event.node.req as { body?: unknown }).body = JSON.stringify({ json: { ...valid } })
    const res = await handler(event)
    if (res instanceof Response && res.status !== 200) console.log('ADDEBUG', (await res.clone().text()).slice(0, 220))
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(200)
    const body = await (res as Response).json() as { json: { name: string } }
    expect(body.json.name).toBe(valid.name)
  })

  it('returns 404 text when handler does not match', async () => {
    const mod = await import('../server/routes/rpc/[...]')
    const handler = mod.default
    const event = makeEvent({ method: 'POST', url: '/rpc/definitely/not/here' })
    ;(event.node.req as { body?: unknown }).body = JSON.stringify({ json: {} })
    const res = await handler(event)
    expect(res).toBe('Not found')
  })
})
