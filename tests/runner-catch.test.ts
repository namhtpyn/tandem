// The dispatchTask catch arm: a throwing ssh-exec surfaces as a failed run.
// Own file: vi.resetModules here cannot poison other suites' module graphs.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

process.env.TANDEM_FAKE_RUNNER = ''

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

vi.mock('../server/domains/tasks/ssh-exec.util', () => ({
  // the ACP transport opens through loadClient — a throwing client loader is
  // today's equivalent of the old throwing ssh exec
  loadClient: async () => { throw new Error('ssh exploded') },
}))

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user, environments, aiEmployees, tasks } = await import('../server/db/schema')
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await db.insert(user).values({ id: 'u-agent', name: 'Robby', email: 'robby@tandem.local', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'u' })
  await db.insert(aiEmployees).values({ userId: 'u-agent', environmentId: 'env-1', instructions: '', executable: 'hermes acp' })
  await db.insert(tasks).values({ id: 't-1', title: 'Boom', description: '', status: 'todo', assigneeId: 'u-agent' })
})

describe('dispatchTask catch arm', () => {
  it('a throwing ssh exec fails the run and logs the error', async () => {
    const { dispatchTask } = await import('../server/domains/tasks/runner.service')
    const handle = await dispatchTask('t-1', 'http://t.local')
    const res = await handle.finished
    expect(res.status).toBe('failed')
    const { db } = await import('../server/db')
    const { taskRuns } = await import('../server/db/schema')
    const run = (await db.select().from(taskRuns))[0]!
    expect(run.output).toContain('ssh exploded')
    expect(run.status).toBe('failed')
  }, 10_000)
})
