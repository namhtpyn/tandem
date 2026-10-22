import { describe, expect, it } from 'vitest'
import './helpers/pg'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '#server/db/index'
import { uuidv7 } from '#server/domains/kernel/ids'

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const admin = { user: { id: 'test-admin', name: 'Test Admin', email: 'test@tandem.local', role: 'admin' } }

async function proc(path: string[], input?: unknown) {
  const { appRouter: router } = await import('#server/domains/app.router')
  const { buildServerContext } = await import('#server/domains/kernel/context')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const k of path) node = node[k] as Record<string, unknown>
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => admin
  ;(context as unknown as { session: typeof admin }).session = admin
  return (node['~orpc'] as { handler: (o: unknown) => Promise<unknown> }).handler({ input, context, signal: new AbortController().signal })
}

describe('uuidv7 ids', () => {
  it('mints valid, unique, time-ordered ids (uuid pkg v7)', async () => {
    const ids = Array.from({ length: 200 }, () => uuidv7())
    for (const id of ids) expect(id).toMatch(UUID7)
    expect(new Set(ids).size).toBe(ids.length)
    // monotonic across a small gap (v7 sorts lexicographically by time)
    const a = uuidv7()
    await new Promise(r => setTimeout(r, 3))
    const b = uuidv7()
    expect(b > a).toBe(true)
  })

  it('domain minting goes through uuidv7 — created rows carry v7 ids', async () => {
    await resetSchema()
    await applyMigrations()
    const res = await proc(['vault', 'folders', 'save'], { name: 'v7 check' }) as { id: string }
    expect(res.id).toMatch(UUID7)
  })
})
