// task statuses: CRUD + transition enforcement on tasks
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx() {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers()) as Record<string, unknown>
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin })
  context.session = { user: admin }
  return context
}

async function dbm() {
  return await import('../server/db')
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { router } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user } = await import('../server/db/schema')
  await db.insert(user).values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: 'admin', title: 'T' })
})

describe('task statuses', () => {
  it('live returns seeded statuses ordered with transitions', async () => {
    const iter = await callProc('statuses.live')
    const snap = (await iter.next()).value
    const rows = (snap as any).status === 'pending' ? (await iter.next()).value : snap
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? rows
    const ids = (list as any[]).map(x => x.id)
    expect(ids).toEqual(['todo', 'doing', 'done'])
    expect((list as any[]).find(x => x.id === 'doing')!.nextIds).toContain('done')
  })

  it('save creates a status with transitions; unknown transition rejected', async () => {
    const r = await callProc('statuses.save', { name: 'In review', color: 'warning', position: 2, isDone: false, nextIds: ['done'] })
    expect(r.id).toBeTruthy()
    await expect(callProc('statuses.save', { name: 'Bad', color: 'neutral', position: 5, isDone: false, nextIds: ['ghost'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('save upserts by id (rename)', async () => {
    const r = await callProc('statuses.save', { id: 'todo', name: 'Backlog', color: 'neutral', position: 0, isDone: false, nextIds: ['doing'] })
    expect(r.id).toBe('todo')
    const { db } = await dbm()
    const { taskStatuses } = await import('../server/db/schema')
    const row = (await db.select().from(taskStatuses)).find(x => x.id === 'todo')!
    expect(row.name).toBe('Backlog')
  })

  it('remove blocked while a task uses the status', async () => {
    const t = await callProc('tasks.create', { title: 'T1' })
    await expect(callProc('statuses.remove', { id: 'todo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await callProc('tasks.remove', { id: t.id })
    await expect(callProc('statuses.remove', { id: 'todo' })).resolves.toMatchObject({ ok: true })
  })

  it('save rejects reserved id "new"', async () => {
    await expect(callProc('statuses.save', { id: 'new', name: 'N', color: 'neutral', position: 9, isDone: false, nextIds: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('create with no statuses defined fails clearly', async () => {
    // remove all seeded statuses (no tasks exist)
    for (const id of ['todo', 'doing', 'done']) await callProc('statuses.remove', { id })
    await expect(callProc('tasks.create', { title: 'NoStatus' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /no task statuses/i })
  })

  it('remove unknown 404s', async () => {
    await expect(callProc('statuses.remove', { id: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('tasks.create validates status; default = first status', async () => {
    const t = await callProc('tasks.create', { title: 'A' })
    const { db } = await dbm()
    const { tasks } = await import('../server/db/schema')
    const row = (await db.select().from(tasks)).find(x => x.id === t.id)!
    expect(row.status).toBe('todo')
    await expect(callProc('tasks.create', { title: 'B', status: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const t2 = await callProc('tasks.create', { title: 'C', status: 'doing' })
    const row2 = (await db.select().from(tasks)).find(x => x.id === t2.id)!
    expect(row2.status).toBe('doing')
  })

  it('tasks.update enforces transitions (todo -> done blocked, todo -> doing ok)', async () => {
    const t = await callProc('tasks.create', { title: 'X' })
    await expect(callProc('tasks.update', { id: t.id, status: 'done' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /cannot move/i })
    await callProc('tasks.update', { id: t.id, status: 'doing' })
    await callProc('tasks.update', { id: t.id, status: 'done' })
    await expect(callProc('tasks.update', { id: t.id, status: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /does not exist/i })
  })

  it('tasks.update same-status is a no-op pass', async () => {
    const t = await callProc('tasks.create', { title: 'Y' })
    await expect(callProc('tasks.update', { id: t.id, status: 'todo' })).resolves.toMatchObject({ ok: true })
  })
})
