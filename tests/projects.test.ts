// projects: CRUD, nesting + cycle guard, task linkage
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import type { ProjectRow, TaskRow } from '../shared/types'

const admin = { id: '00000000-0000-7000-8000-cd5fca5e2d34', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx() {
  const { buildServerContext } = await import('../server/domains/kernel/context')
  const context = buildServerContext(new Headers()) as Record<string, unknown>
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin })
  context.session = { user: admin }
  return context
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router')
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

describe('projects crud', () => {
  it('create + live round-trip', async () => {
    const p = await callProc('projects.create', { name: 'Apollo', description: 'moon stuff' })
    expect(p.id).toBeTruthy()
    const iter = await callProc('projects.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as ProjectRow[]).find(r => r.id === p.id)!
    expect(row.name).toBe('Apollo')
    expect(row.status).toBe('active')
    expect(row.parentId).toBeNull()
  })

  it('update name/status/description', async () => {
    const p = await callProc('projects.create', { name: 'Old' })
    await callProc('projects.update', { id: p.id, name: 'New', status: 'archived', description: 'x' })
    const iter = await callProc('projects.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as ProjectRow[]).find(r => r.id === p.id)!
    expect(row.name).toBe('New')
    expect(row.status).toBe('archived')
    expect(row.description).toBe('x')
  })

  it('remove deletes; tasks orphan to no-project', async () => {
    const p = await callProc('projects.create', { name: 'Doomed' })
    const t = await callProc('tasks.create', { title: 'T1', projectId: p.id })
    expect(t.id).toBeTruthy()
    await callProc('projects.remove', { id: p.id })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const task = (snap.value as TaskRow[]).find(r => r.id === t.id)!
    expect(task.projectId).toBeNull()
    expect(task.projectName).toBeNull()
  })
})

describe('nesting', () => {
  it('child carries parentId; deleting parent orphans child to root', async () => {
    const parent = await callProc('projects.create', { name: 'Parent' })
    const child = await callProc('projects.create', { name: 'Child', parentId: parent.id })
    await callProc('projects.remove', { id: parent.id })
    const iter = await callProc('projects.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as ProjectRow[]).find(r => r.id === child.id)!
    expect(row.parentId).toBeNull()
  })

  it('self-parent rejected', async () => {
    const p = await callProc('projects.create', { name: 'Self' })
    await expect(callProc('projects.update', { id: p.id, parentId: p.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('cycle (grandchild under itself) rejected', async () => {
    const a = await callProc('projects.create', { name: 'A' })
    const b = await callProc('projects.create', { name: 'B', parentId: a.id })
    // move A under B => A->B->A cycle
    await expect(callProc('projects.update', { id: a.id, parentId: b.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('unknown parent rejected (create + update)', async () => {
    await expect(callProc('projects.create', { name: 'X', parentId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const p = await callProc('projects.create', { name: 'Y' })
    await expect(callProc('projects.update', { id: p.id, parentId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('move under a root-level parent (walk terminates at root)', async () => {
    const a = await callProc('projects.create', { name: 'RA' })
    const b = await callProc('projects.create', { name: 'RB', parentId: a.id })
    const c = await callProc('projects.create', { name: 'RC' })
    // C under B: walk B(parent A) -> A(parent null) -> stop; no cycle
    await callProc('projects.update', { id: c.id, parentId: b.id })
    const iter = await callProc('projects.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as ProjectRow[]).find(r => r.id === c.id)!
    expect(row.parentId).toBe(b.id)
  })

  it('null parent clears nesting', async () => {
    const parent = await callProc('projects.create', { name: 'P' })
    const child = await callProc('projects.create', { name: 'C', parentId: parent.id })
    await callProc('projects.update', { id: child.id, parentId: null })
    const iter = await callProc('projects.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as ProjectRow[]).find(r => r.id === child.id)!
    expect(row.parentId).toBeNull()
  })
})

describe('task project linkage', () => {
  it('create with project; live shows projectName; update moves it', async () => {
    const p1 = await callProc('projects.create', { name: 'One' })
    const p2 = await callProc('projects.create', { name: 'Two' })
    const t = await callProc('tasks.create', { title: 'T', projectId: p1.id })
    let iter = await callProc('tasks.live')
    let snap = await iter.next()
    await iter.return?.()
    let task = (snap.value as TaskRow[]).find(r => r.id === t.id)!
    expect(task.projectName).toBe('One')
    await callProc('tasks.update', { id: t.id, projectId: p2.id })
    iter = await callProc('tasks.live')
    snap = await iter.next()
    await iter.return?.()
    task = (snap.value as TaskRow[]).find(r => r.id === t.id)!
    expect(task.projectName).toBe('Two')
    // clear
    await callProc('tasks.update', { id: t.id, projectId: null })
    iter = await callProc('tasks.live')
    snap = await iter.next()
    await iter.return?.()
    task = (snap.value as TaskRow[]).find(r => r.id === t.id)!
    expect(task.projectId).toBeNull()
  })

  it('unknown project rejected (create + update)', async () => {
    await expect(callProc('tasks.create', { title: 'T', projectId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const t = await callProc('tasks.create', { title: 'T2' })
    await expect(callProc('tasks.update', { id: t.id, projectId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
