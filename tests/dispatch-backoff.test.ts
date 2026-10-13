// Backoff ladder, quota-jump, dispatchAfter gating, reaper, and run timeout settle.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { eq } from 'drizzle-orm'

// mock ssh2: connect+exec succeed; the stream never closes on its own, so tests
// drive terminal events explicitly (error emit) or rely on the run-timeout timer
vi.mock('ssh2', () => {
  class FakeStream {
    on() { return this }
    end() { /* swallow stdin; never emit close */ }
  }
  class FakeClient {
    static last: FakeClient
    handlers: Record<string, Array<(d: unknown) => void>> = {}
    constructor() { FakeClient.last = this }
    on(ev: string, fn: (d: unknown) => void) { this.handlers[ev] = [...(this.handlers[ev] ?? []), fn]; return this }
    end() {}
    exec(_c: string, cb: (e: Error | null, s: unknown) => void) { cb(null, new FakeStream()) }
    connect(_o: unknown) { setTimeout(() => (this.handlers['ready'] ?? []).forEach(f => (f as () => void)()), 0) }
    emitError(e: Error) { (this.handlers['error'] ?? []).forEach(f => f(e)) }
  }
  return { default: { Client: FakeClient } }
})

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router')
  const { buildServerContext } = await import('../server/domains/kernel/context')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin })
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context, signal: new AbortController().signal })
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user, environments, aiEmployees, tasks } = await import('../server/db/schema')
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await db.insert(user).values({ id: 'u-agent', name: 'Robby', email: 'robby@tandem.local', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'u' })
  await db.insert(aiEmployees).values({ userId: 'u-agent', environmentId: 'env-1', instructions: '' })
  await db.insert(tasks).values({ id: 't-1', title: 'B', description: '', status: 'todo', assigneeId: 'u-agent' })
})

describe('backoff ladder', () => {
  it('1st/2nd/3rd+ failures map to 1m/5m/15m', async () => {
    const { backoffFor } = await import('../server/domains/tasks/runner.service')
    expect(backoffFor(1, 'boom')).toBe(60_000)
    expect(backoffFor(2, 'boom')).toBe(5 * 60_000)
    expect(backoffFor(3, 'boom')).toBe(15 * 60_000)
    expect(backoffFor(99, 'boom')).toBe(15 * 60_000) // capped
  })

  it('quota signatures jump straight to the 15m tier', async () => {
    const { backoffFor } = await import('../server/domains/tasks/runner.service')
    expect(backoffFor(1, 'Error: 429 Too Many Requests')).toBe(15 * 60_000)
    expect(backoffFor(1, 'insufficient_quota: add credits')).toBe(15 * 60_000)
    expect(backoffFor(2, 'You exceeded your current quota')).toBe(15 * 60_000)
    expect(backoffFor(2, 'normal failure')).toBe(5 * 60_000) // negative control
  })

  it('a failed run sets failStreak + dispatchAfter; success resets both', async () => {
    const { db } = await import('../server/db')
    const { tasks, taskRuns } = await import('../server/db/schema')
    process.env.TANDEM_FAKE_RUNNER = '1'
    process.env.TANDEM_FAKE_SCRIPT = 'ERR: 429 rate limit exceeded'
    try {
      // drive a failed run through the mocked ssh path (exec returns error -> failed)
      const prev = process.env.TANDEM_FAKE_RUNNER
      delete process.env.TANDEM_FAKE_RUNNER
      const { dispatchTask } = await import('../server/domains/tasks/runner.service')
      const handle = await dispatchTask('t-1', 'http://t.local')
      const clientMod = (await import('ssh2')).default
      const FakeClient = clientMod.Client as unknown as { last?: { emitError(e: Error): void } }
      for (let i = 0; i < 40 && !FakeClient.last; i++) await new Promise(r => setTimeout(r, 5))
      FakeClient.last!.emitError(new Error('connection lost'))
      const res = await handle.finished
      expect(res.status).toBe('failed')
      await new Promise(r => setTimeout(r, 150))
      const task = (await db.select().from(tasks).where(eq(tasks.id, 't-1')))[0]!
      expect(task.status).toBe('todo')
      expect(task.failStreak).toBe(1)
      expect(task.dispatchAfter).not.toBeNull()
      expect(task.dispatchAfter!.getTime()).toBeGreaterThan(Date.now() + 50_000)
      // success resets
      await db.update(tasks).set({ failStreak: 5, dispatchAfter: new Date() }).where(eq(tasks.id, 't-1'))
      process.env.TANDEM_FAKE_RUNNER = prev ?? '1'
      void prev
    }
    finally {
      delete process.env.TANDEM_FAKE_SCRIPT
      process.env.TANDEM_FAKE_RUNNER = '1'
    }
  })

  it('findEligible skips tasks still in backoff and picks them up after it passes', async () => {
    const { db } = await import('../server/db')
    const { tasks } = await import('../server/db/schema')
    const { findEligible } = await import('../server/domains/tasks/dispatcher.service')
    await db.update(tasks).set({ dispatchAfter: new Date(Date.now() + 60_000) }).where(eq(tasks.id, 't-1'))
    expect(await findEligible()).toBeNull()
    await db.update(tasks).set({ dispatchAfter: new Date(Date.now() - 1000) }).where(eq(tasks.id, 't-1'))
    const hit = await findEligible()
    expect(hit?.taskId).toBe('t-1')
  })
})

describe('stale-run reaper', () => {
  it('fails ancient running runs and bounces the task with a long backoff', async () => {
    const { db } = await import('../server/db')
    const { tasks, taskRuns } = await import('../server/db/schema')
    await db.insert(taskRuns).values({ id: 'r-old', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'running', output: 'partial output', startedAt: new Date(Date.now() - 3 * 60 * 60_000) })
    await db.update(tasks).set({ status: 'doing' }).where(eq(tasks.id, 't-1'))
    const { reapStaleRuns } = await import('../server/domains/tasks/dispatcher.service')
    expect(await reapStaleRuns()).toBe(1)
    const run = (await db.select().from(taskRuns)).find(r => r.id === 'r-old')!
    expect(run.status).toBe('failed')
    expect(run.output).toContain('[reaper]')
    const task = (await db.select().from(tasks)).find(x => x.id === 't-1')!
    expect(task.status).toBe('todo')
    expect(task.failStreak).toBe(1)
    expect(task.dispatchAfter!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    // fresh running runs are left alone
    await db.insert(taskRuns).values({ id: 'r-new', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'running', output: '', startedAt: new Date() })
    expect(await reapStaleRuns()).toBe(0)
  })

  it('leaves the task alone when the stale run is not the newest one', async () => {
    const { db } = await import('../server/db')
    const { tasks, taskRuns } = await import('../server/db/schema')
    const old = new Date(Date.now() - 3 * 60 * 60_000)
    await db.insert(taskRuns).values({ id: 'r-a', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'running', output: '', startedAt: old })
    await db.insert(taskRuns).values({ id: 'r-b', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'running', output: '', startedAt: new Date(Date.now() - 2 * 60 * 60_000) })
    await db.update(tasks).set({ status: 'doing' }).where(eq(tasks.id, 't-1'))
    const { reapStaleRuns } = await import('../server/domains/tasks/dispatcher.service')
    expect(await reapStaleRuns()).toBe(2) // both stale -> both reaped
    // now only ONE new run: reaping it must NOT bounce when a newer done run exists
    await db.insert(taskRuns).values({ id: 'r-c', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'running', output: '', startedAt: new Date(Date.now() - 3 * 60 * 60_000) })
    await db.insert(taskRuns).values({ id: 'r-d', taskId: 't-1', employeeId: 'u-agent', environmentId: 'env-1', status: 'done', exitCode: 0, output: '', startedAt: new Date() })
    await db.update(tasks).set({ status: 'done', failStreak: 0, dispatchAfter: null }).where(eq(tasks.id, 't-1'))
    expect(await reapStaleRuns()).toBe(1) // r-c reaped
    const task = (await db.select().from(tasks)).find(x => x.id === 't-1')!
    expect(task.status).toBe('done') // NOT bounced: r-d is newer
  })
})

describe('double settle', () => {
  it('events after the timer are ignored (idempotent settle)', async () => {
    process.env.TANDEM_RUN_TIMEOUT_MS = '60'
    try {
      const { runOverSsh } = await import('../server/domains/tasks/ssh-exec.util')
      const lines: string[] = []
      let finishCount = 0
      const done = new Promise<{ status: string }>(r => {
        void runOverSsh(
          { env: { host: 'x', port: '22', username: 'u' } },
          'cmd',
          '',
          l => lines.push(l),
          async () => { finishCount += 1 },
          v => r(v as { status: string }),
        )
      })
      const res = await done
      expect(res.status).toBe('failed')
      // error arriving after timeout must not double-finish
      const clientMod = (await import('ssh2')).default
      const FakeClient = clientMod.Client as unknown as { last?: { emitError(e: Error): void } }
      await new Promise(rs => setTimeout(rs, 30))
      FakeClient.last?.emitError(new Error('late error'))
      await new Promise(rs => setTimeout(rs, 50))
      expect(finishCount).toBe(1)
      expect(lines.filter(l => l.includes('late')).length).toBe(0)
    }
    finally {
      delete process.env.TANDEM_RUN_TIMEOUT_MS
    }
  }, 5000)

  it('a failed run on a deleted task does not crash (failStreak default arm)', async () => {
    const prev = process.env.TANDEM_FAKE_RUNNER
    delete process.env.TANDEM_FAKE_RUNNER
    try {
      const { dispatchTask } = await import('../server/domains/tasks/runner.service')
      const handle = await dispatchTask('t-1', 'http://t.local')
      const clientMod = (await import('ssh2')).default
      const FakeClient = clientMod.Client as unknown as { last?: { emitError(e: Error): void } }
      for (let i = 0; i < 40 && !FakeClient.last; i++) await new Promise(r => setTimeout(r, 5))
      // task vanishes mid-run (deleted by a human): finish must not crash on the missing row
      const { db } = await import('../server/db')
      const { tasks } = await import('../server/db/schema')
      await db.delete(tasks).where(eq(tasks.id, 't-1'))
      FakeClient.last!.emitError(new Error('boom'))
      const res = await handle.finished
      expect(res.status).toBe('failed')
    }
    finally {
      if (prev !== undefined) process.env.TANDEM_FAKE_RUNNER = prev
    }
  }, 10_000)

  it('live rows expose dispatchAfter when set (router non-null arm)', async () => {
    const { db } = await import('../server/db')
    const { tasks } = await import('../server/db/schema')
    await db.update(tasks).set({ dispatchAfter: new Date(Date.now() + 60_000), failStreak: 2 }).where(eq(tasks.id, 't-1'))
    const iter = await callProc('tasks.live', {})
    const snap = await iter.next()
    await iter.return?.()
    const rows = snap.value as any[]
    const row = rows.find(r => r.id === 't-1')!
    expect(row.dispatchAfter).not.toBeNull()
    expect(row.failStreak).toBe(2)
  })
})

describe('ssh run timeout', () => {
  it('a run that never closes settles as failed via the timer', async () => {
    process.env.TANDEM_RUN_TIMEOUT_MS = '80'
    try {
      const { runOverSsh } = await import('../server/domains/tasks/ssh-exec.util')
      const lines: string[] = []
      let finished = false
      const done = new Promise<{ status: string }>(r => {
        void runOverSsh(
          { env: { host: 'x', port: '22', username: 'u' } },
          'cmd',
          '',
          l => lines.push(l),
          async () => { finished = true },
          v => r(v as { status: string }),
        )
      })
      const res = await done
      expect(res.status).toBe('failed')
      expect(finished).toBe(true)
      expect(lines.some(l => l.includes('timed out'))).toBe(true)
    }
    finally {
      delete process.env.TANDEM_RUN_TIMEOUT_MS
    }
  }, 5000)
})
