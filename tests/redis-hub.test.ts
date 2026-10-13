// Redis hub integration tests — real redis on 127.0.0.1:6399 (docker redis-spike), skipped when unreachable.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

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

describe.skipIf(!up)('redis hub (integration)', () => {
  beforeAll(() => { process.env.REDIS_URL = REDIS_URL })

  it('enqueues and processes a job through the queue', async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    const hub = await redisHub()
    expect(hub).toBeTruthy()
    const got: number[] = []
    let resolveDone: () => void = () => {}
    const finished = new Promise<void>(r => { resolveDone = r })
    await hub!.queue<{ n: number }>('itest', async (d) => {
      got.push(d.n)
      resolveDone()
    })
    await hub!.enqueue('itest', { n: 42 })
    await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])
    expect(got).toContain(42)
  })

  it('pub/sub delivers messages across connections', async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    const hub = await redisHub()
    const got = new Promise<string>(r => void hub!.subscribe('itest-chan', m => r(m)))
    await new Promise(rs => setTimeout(rs, 100))
    await hub!.publish('itest-chan', 'ping')
    expect(await got).toBe('ping')
  })

  it('cache set/get round-trips with TTL', async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    const hub = await redisHub()
    await hub!.cacheSet('itest-k', 'v', 30)
    expect(await hub!.cacheGet('itest-k')).toBe('v')
  })

  it('change encoding round-trips', async () => {
    const { encodeChange, decodeChange } = await import('../server/domains/kernel/redis')
    const e = { id: '1', resource: 'tasks' as const, action: 'update' as const, at: '2026-10-13T00:00:00Z' }
    expect(decodeChange(encodeChange(e))).toEqual(e)
  })

  afterAll(async () => {
    const { redisHub } = await import('../server/domains/kernel/redis')
    const hub = await redisHub()
    await hub?.close()
    delete process.env.REDIS_URL
  })
})
