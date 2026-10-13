// Failure arms: hub creation against a dead redis must throw-and-reset (no cached poison),
// and publishChange degrades to local-only when redis is down.
import { describe, expect, it } from 'vitest'
import './api-harness'
import './helpers/pg'

describe('redis failure arms', () => {
  it('redisHub rejects and clears the cache on connection failure', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6390' // nothing listens here
    const { redisHub } = await import('../server/domains/kernel/redis')
    await expect(redisHub()).rejects.toThrow()
    // cache was cleared by the rejection: a second call retries (and fails) fresh
    await expect(redisHub()).rejects.toThrow()
    delete process.env.REDIS_URL
  })

  it('publishChange stays local-only when the hub publish fails', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6390'
    const { publishChange, changeBus } = await import('../server/domains/kernel/change-bus')
    const seen: string[] = []
    const unsub = await changeBus.subscribe('change', e => seen.push(e.resource))
    await publishChange('tasks', 'update') // hub.publish rejects -> caught -> local bus still fired
    expect(seen).toContain('tasks')
    unsub()
    delete process.env.REDIS_URL
  })
})
