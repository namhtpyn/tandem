// Redis-down arm: scanOnce must return false (not throw) when enqueue fails.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

vi.mock('../server/domains/kernel/redis', () => ({
  redisHub: async () => ({
    queue: async () => ({ close: async () => {} }),
    enqueue: async () => { throw new Error('ECONNREFUSED') },
    publish: async () => {},
    subscribe: async () => {},
    cacheGet: async () => null,
    cacheSet: async () => {},
    close: async () => {},
  }),
  redisUrl: () => 'redis://mocked',
  CHANGE_CHANNEL: 'tandem:changes',
  encodeChange: (e: unknown) => JSON.stringify(e),
  decodeChange: (raw: string) => JSON.parse(raw),
}))

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user, environments, aiEmployees, tasks } = await import('../server/db/schema')
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await db.insert(user).values({ id: 'u-agent', name: 'Robby', email: 'robby@tandem.local', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'u' })
  await db.insert(aiEmployees).values({ userId: 'u-agent', environmentId: 'env-1', instructions: '' })
  await db.insert(tasks).values({ id: 't-1', title: 'Down', description: '', status: 'todo', assigneeId: 'u-agent' })
})

describe('dispatch with redis down', () => {
  it('enqueue failure yields false without throwing', async () => {
    const { scanOnce } = await import('../server/domains/tasks/dispatcher.service')
    expect(await scanOnce('http://t.local')).toBe(false)
  })
})
