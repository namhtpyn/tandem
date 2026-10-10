// tasks router: create/update/remove + live mapping with assignee info
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

async function dbm() {
  return await import('../server/db')
}
async function schema() {
  return await import('../server/db/schema')
}

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null = admin) {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  return context
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { router } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

async function seedEnv(id: string): Promise<void> {
  const { db } = await dbm()
  const { environments } = await schema()
  await db.insert(environments).values({ id, name: id, host: '127.0.0.1', port: '22', username: 'u' })
}

async function mkEmployee(name: string, email: string): Promise<string> {
  const r = await callProc('employees.create', { name, email, kind: 'human', title: 'T', supervisorIds: [] })
  return r.id
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('tasks', () => {
  it('live is empty on a fresh database', async () => {
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    expect(snap.value).toEqual([])
    await iter.return?.()
  })

  it('create + live maps assignee name/kind (human)', async () => {
    const empId = await mkEmployee('Task Owner', 'to@tandem.local')
    const r = await callProc('tasks.create', { title: 'First task', description: 'do it', assigneeId: empId })
    expect(r.id).toBeTruthy()
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const rows = snap.value as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('First task')
    expect(rows[0].status).toBe('todo')
    expect(rows[0].assigneeId).toBe(empId)
    expect(rows[0].assigneeName).toBe('Task Owner')
    expect(rows[0].assigneeKind).toBe('human')
  })

  it('create without assignee -> unassigned row', async () => {
    await callProc('tasks.create', { title: 'Unassigned' })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const rows = snap.value as any[]
    expect(rows[0].assigneeId).toBeNull()
    expect(rows[0].assigneeName).toBeNull()
    expect(rows[0].assigneeKind).toBeNull()
  })

  it('create rejects a nonexistent assignee', async () => {
    await expect(callProc('tasks.create', { title: 'X', assigneeId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('update changes title/status/assignee; done sticks', async () => {
    const a = await mkEmployee('A', 'a@t.local')
    const b = await mkEmployee('B', 'b@t.local')
    const r = await callProc('tasks.create', { title: 'T1', assigneeId: a })
    await callProc('tasks.update', { id: r.id, title: 'T1 renamed', status: 'doing', assigneeId: b })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[])[0]
    expect(row.title).toBe('T1 renamed')
    expect(row.status).toBe('doing')
    expect(row.assigneeName).toBe('B')
    await callProc('tasks.update', { id: r.id, status: 'done' })
    const { tasks } = await schema()
    const { db } = await dbm()
    const t = (await db.select().from(tasks).where(eq(tasks.id, r.id)))[0]!
    expect(t.status).toBe('done')
  })

  it('update unassigns via null', async () => {
    const a = await mkEmployee('A', 'a2@t.local')
    const r = await callProc('tasks.create', { title: 'T2', assigneeId: a })
    await callProc('tasks.update', { id: r.id, assigneeId: null })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    expect((snap.value as any[])[0].assigneeId).toBeNull()
  })

  it('update rejects unknown task and bad assignee', async () => {
    await expect(callProc('tasks.update', { id: 'ghost', title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const r = await callProc('tasks.create', { title: 'T3' })
    await expect(callProc('tasks.update', { id: r.id, assigneeId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('remove deletes the row', async () => {
    const r = await callProc('tasks.create', { title: 'T4' })
    await callProc('tasks.remove', { id: r.id })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    expect(snap.value).toEqual([])
    await expect(callProc('tasks.remove', { id: r.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('description update paths: null skips, value replaces', async () => {
    const r = await callProc('tasks.create', { title: 'T-desc', description: 'keep me' })
    await callProc('tasks.update', { id: r.id, description: null })
    let iter = await callProc('tasks.live')
    let snap = await iter.next()
    await iter.return?.()
    expect((snap.value as any[])[0].description).toBe('keep me')
    await callProc('tasks.update', { id: r.id, description: 'replaced', status: 'todo' })
    iter = await callProc('tasks.live')
    snap = await iter.next()
    await iter.return?.()
    expect((snap.value as any[])[0].description).toBe('replaced')
  })

  it('AI assignee maps assigneeKind ai', async () => {
    await seedEnv('env-ai-kind')
    const bot = await callProc('employees.create', { name: 'Kind Bot', email: 'kb@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-ai-kind' })
    const r = await callProc('tasks.create', { title: 'T-ai', assigneeId: bot.id })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find((x: any) => x.id === r.id)!
    expect(row.assigneeKind).toBe('ai')
  })

  it('deleting an employee nulls their tasks (set null)', async () => {
    const a = await mkEmployee('Gone', 'gone@t.local')
    const r = await callProc('tasks.create', { title: 'T5', assigneeId: a })
    await callProc('employees.remove', { id: a })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find((x: any) => x.id === r.id)!
    expect(row.assigneeId).toBeNull()
  })
})
