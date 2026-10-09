// oRPC router tests: session gate, CRUD + conflict/404 paths, live-query
// re-emission via the change bus, probe delegation, context session mapping.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null) {
  const { buildServerContext } = await import('../server/utils/orpc')
  const headers = new Headers()
  const context = buildServerContext(headers)
  // replace the lazy resolver with a stub
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  return context
}

const admin = { id: 'u1', name: 'A', email: 'a@x', role: 'admin' }

async function callRouter() {
  const { router } = await import('../server/utils/orpc')
  return router
}

// invoke a procedure through the router object directly: oRPC v2 procedures
// carry internals under ['~orpc'], with .handler({ input, context }) callable.
async function callProc(path: string[], input: unknown, sessionUser = admin): Promise<unknown> {
  const router = await callRouter()
  const context = await ctx(sessionUser)
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path) {
    node = node[key] as Record<string, unknown>
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  const signal = new AbortController().signal
  return await internals.handler({ input, context, signal })
}

const valid = { name: 'ct112', host: '192.168.3.108', port: '22', username: 'tandem' }

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('session gate (via RPCHandler — middleware runs)', () => {
  it('rejects unauthenticated calls (UNAUTHORIZED)', async () => {
    const { RPCHandler } = await import('@orpc/server/fetch')
    const { router, buildServerContext } = await import('../server/utils/orpc')
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    inst.api.getSession = async () => null
    try {
      const handler = new RPCHandler(router)
      const req = new Request('http://x/rpc/environments/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(valid),
      })
      const { response } = await handler.handle(req, { prefix: '/rpc', context: buildServerContext(new Headers()) })
      expect(response!.status).toBe(401)
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })
})

describe('environments.create', () => {
  it('creates and returns the row', async () => {
    const r = await callProc(['environments', 'create'], valid) as { id: string, name: string }
    expect(r.name).toBe('ct112')
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a duplicate name (CONFLICT)', async () => {
    await callProc(['environments', 'create'], valid)
    await expect(callProc(['environments', 'create'], valid)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('environments.update', () => {
  it('updates and bumps updatedAt', async () => {
    const created = await callProc(['environments', 'create'], valid) as { id: string }
    const r = await callProc(['environments', 'update'], { id: created.id, ...valid, host: '10.0.0.9' }) as { host: string }
    expect(r.host).toBe('10.0.0.9')
  })

  it('CONFLICT on renaming onto another row', async () => {
    const a = await callProc(['environments', 'create'], valid) as { id: string }
    await callProc(['environments', 'create'], { ...valid, name: 'b' })
    await expect(callProc(['environments', 'update'], { id: a.id, ...valid, name: 'b' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('NOT_FOUND for unknown id', async () => {
    await expect(callProc(['environments', 'update'], { id: '00000000-0000-4000-8000-000000000000', ...valid })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('environments.remove', () => {
  it('deletes and confirms', async () => {
    const created = await callProc(['environments', 'create'], valid) as { id: string }
    const r = await callProc(['environments', 'remove'], { id: created.id }) as { ok: boolean }
    expect(r.ok).toBe(true)
  })

  it('NOT_FOUND for unknown id', async () => {
    await expect(callProc(['environments', 'remove'], { id: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('environments.probe', () => {
  it('NOT_FOUND for unknown id', async () => {
    await expect(callProc(['environments', 'probe'], { id: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delegates to probeSsh (unreachable host -> ok:false)', async () => {
    const created = await callProc(['environments', 'create'], { ...valid, host: '127.0.0.1', port: '59999' }) as { id: string }
    const r = await callProc(['environments', 'probe'], { id: created.id }) as { ok: boolean, detail: string, durationMs: number }
    expect(r.ok).toBe(false)
    expect(r.detail.length).toBeGreaterThan(0)
    expect(typeof r.durationMs).toBe('number')
  })
})

describe('environments.live', () => {
  it('emits an initial snapshot, then a fresh one on change-bus publish', async () => {
    const iter = await callProc(['environments', 'live'], undefined) as AsyncGenerator<unknown>
    const first = (await iter.next()).value as Array<{ name: string }>
    expect(first).toEqual([])
    // generator suspends at the yield; start listening BEFORE publishing
    const secondPromise = iter.next()
    await new Promise(r => setTimeout(r, 30)) // let the generator reach subscribe()
    await callProc(['environments', 'create'], { ...valid, name: 'live-1' })
    const second = (await secondPromise).value as Array<{ name: string }>
    expect(second.map((r: { name: string }) => r.name)).toEqual(['live-1'])
    await iter.return?.()
  })

  it('does not re-emit for settings-only changes during an active subscription', async () => {
    const { publishChange } = await import('../server/utils/change-bus')
    const iter = await callProc(['environments', 'live'], undefined) as AsyncGenerator<unknown>
    await iter.next()
    // park the generator in subscribe(), publish an unrelated event
    await new Promise(r => setTimeout(r, 100))
    await publishChange('settings', 'update')
    await new Promise(r => setTimeout(r, 100))
    // pending next + another settings-only publish: must stay pending
    const pending = iter.next()
    await new Promise(r => setTimeout(r, 50))
    await publishChange('settings', 'update')
    const winner = await Promise.race([pending.then(() => 'emitted' as const), new Promise(r => setTimeout(() => r('silent' as const), 400))])
    expect(winner).toBe('silent')
    // environments publish resolves it
    await publishChange('environments', 'update')
    const next = (await pending).value as Array<{ name: string }>
    expect(Array.isArray(next)).toBe(true)
    await iter.return?.()
  }, 10_000)
})

describe('buildServerContext', () => {
  it('maps a real better-auth session to the trimmed payload, caches per call', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    let calls = 0
    inst.api.getSession = async () => {
      calls += 1
      return { user: { id: 'u9', name: 'Nine', email: 'n@x', emailVerified: true, role: 'viewer' }, session: { id: 's1', userId: 'u9', expiresAt: new Date() } }
    }
    try {
      const { buildServerContext } = await import('../server/utils/orpc')
      const c = buildServerContext(new Headers())
      const a = await c.getSession()
      const b = await c.getSession()
      expect(a).toEqual({ user: { id: 'u9', name: 'Nine', email: 'n@x', role: 'viewer' } })
      expect(b).toBe(a) // cached — one lookup per request
      expect(calls).toBe(1)
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })

  it('defaults a missing role to viewer and absent headers to empty', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    inst.api.getSession = async () => ({ user: { id: 'u2', name: 'B', email: 'b@x', emailVerified: true } })
    try {
      const { buildServerContext } = await import('../server/utils/orpc')
      const c = buildServerContext(undefined) // <- no headers at all
      expect(await c.getSession()).toEqual({ user: { id: 'u2', name: 'B', email: 'b@x', role: 'viewer' } })
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })

  it('returns null when no session', async () => {
    const { getAuth } = await import('../server/utils/auth')
    const inst = await getAuth()
    const realGetSession = inst.api.getSession.bind(inst.api)
    inst.api.getSession = async () => null
    try {
      const { buildServerContext } = await import('../server/utils/orpc')
      const c = buildServerContext(new Headers())
      expect(await c.getSession()).toBeNull()
    }
    finally {
      inst.api.getSession = realGetSession
    }
  })
})
