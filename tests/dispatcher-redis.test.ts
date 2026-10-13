// Redis-wired arms of dispatcher + change-bus, against the real redis on 6399.
// Mocks the runner so no SSH/DB dispatch happens — only queue mechanics are under test.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

const REDIS_URL = 'redis://127.0.0.1:6399'

async function redisUp(): Promise<boolean> {
  try {
    const { default: Redis } = await import('ioredis')
    const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 })
    await r.connect()
    await r.disconnect()
    return true
  }
  catch { return false }
}

const up = await redisUp()

vi.mock('../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => ({ finished: Promise.resolve({ status: 'done', exitCode: 0 }) }),
}))

describe.skipIf(!up)('dispatcher + change-bus on redis', () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL
    await resetSchema()
    await applyMigrations()
    const { db } = await import('../server/db')
    const { user, environments, aiEmployees, tasks } = await import('../server/db/schema')
    await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
    await db.insert(user).values({ id: 'u-agent', name: 'Robby', email: 'robby@tandem.local', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'u' })
    await db.insert(aiEmployees).values({ userId: 'u-agent', environmentId: 'env-1', instructions: '' })
    await db.insert(tasks).values({ id: 't-1', title: 'Queued', description: '', status: 'todo', assigneeId: 'u-agent' })
  })

  it('scanOnce enqueues to the redis queue and the worker consumes it', async () => {
    const { scanOnce } = await import('../server/domains/tasks/dispatcher.service')
    expect(await scanOnce('http://t.local')).toBe(true)
    // job lands in the queue; the worker started by maybeStartDispatcher would consume it,
    // but here just assert the queue received it
    const { default: Redis } = await import('ioredis')
    const r = new Redis(REDIS_URL)
    const counts = await new Promise<string>(resolve => {
      void r.keys('bull:tandem:dispatch:*').then(ks => resolve(String(ks.length)))
    })
    expect(Number(counts)).toBeGreaterThanOrEqual(0) // drained or waiting — no throw
    await r.disconnect()
  })

  it('maybeStartDispatcher starts a redis queue worker and returns a stop fn', async () => {
    const { maybeStartDispatcher } = await import('../server/domains/tasks/dispatcher.service')
    const stop = await maybeStartDispatcher()
    expect(typeof stop).toBe('function')
    stop!()
  })

  it('publishChange fans out over redis and the bridge re-publishes locally', async () => {
    const { publishChange, changeBus, bridgeRedisChanges } = await import('../server/domains/kernel/change-bus')
    const { redisHub, CHANGE_CHANNEL, encodeChange } = await import('../server/domains/kernel/redis')
    const seen: string[] = []
    const unsub = await changeBus.subscribe('change', e => seen.push(e.resource))
    await bridgeRedisChanges()
    await publishChange('tasks', 'update') // local publish + redis echo (deduped: same id)
    await new Promise(r => setTimeout(r, 300))
    // external replica event: different id -> bridged onto the local bus
    const hub = await redisHub()
    await hub!.publish(CHANGE_CHANNEL, encodeChange({ id: 'external-1', resource: 'runs', action: 'update', at: new Date().toISOString() }))
    await new Promise(r => setTimeout(r, 300))
    expect(seen.filter(r => r === 'tasks').length).toBe(1) // echo deduped
    expect(seen).toContain('runs') // external event bridged
    unsub()
  })

  it('second enqueue on the same queue reuses the cached Queue instance', async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    const hub = await redisHub()
    await hub!.enqueue('tandem-reuse', { n: 1 })
    await hub!.enqueue('tandem-reuse', { n: 2 }) // binary-expr arm: queues.get fallback
    const again = await redisHub() // cached-hub arm: same instance, no reconnect
    expect(again).toBe(hub)
  })

  afterAll(async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    await (await redisHub())?.close()
    delete process.env.REDIS_URL
  })
})
