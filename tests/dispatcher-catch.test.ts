// scanOnce's catch arm: a dispatchTask throw (task vanished between find and claim)
// must surface as "not dispatched", never as a scan-loop crash.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { STATUS } from '../shared/status'

vi.mock('../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => { throw new Error('task vanished') },
}))

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user, tasks, environments, aiEmployees } = await import('../server/db/schema')
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await db.insert(user).values({ id: 'u-agent', name: 'Robby', email: 'robby@tandem.local', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'u' })
  await db.insert(aiEmployees).values({ userId: 'u-agent', environmentId: 'env-1', instructions: '', executable: 'hermes acp' })
  await db.insert(tasks).values({ id: 't-1', title: 'Ghost', description: '', status: STATUS.todo, assigneeId: 'u-agent' })
})

describe('scanOnce catch arm', () => {
  it('a throwing dispatchTask resolves to false', async () => {
    const { scanOnce } = await import('../server/domains/tasks/dispatcher.service')
    expect(await scanOnce('http://t.local')).toBe(false)
  })
})
