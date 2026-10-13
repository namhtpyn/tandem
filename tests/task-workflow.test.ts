// Task workflow: question → forward chain → answer; submit → unanimous review → done.
// Laws (user, 2026-10-13):
//   1. owner ≠ supervisor — no hierarchy coupling
//   2. ALL reviewers must approve
//   3. reviewer/assignee: AI or human, no restriction
//   4. forward is a free chain; stops at the top of the hierarchy; no revisits
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }
const worker = { id: 'u-worker', name: 'Worker', email: 'worker@tandem.local', role: 'member' }
const ownerUser = { id: 'u-owner', name: 'Owner', email: 'owner@tandem.local', role: 'member' }
const rev1 = { id: 'u-rev1', name: 'Rev One', email: 'rev1@tandem.local', role: 'member' }
const rev2 = { id: 'u-rev2', name: 'Rev Two', email: 'rev2@tandem.local', role: 'member' }
const top = { id: 'u-top', name: 'Top', email: 'top@tandem.local', role: 'member' }

let currentSession: typeof admin = admin

async function dbm() {
  return await import('../server/db')
}
async function schema() {
  return await import('../server/db/schema')
}

async function ctx() {
  const { buildServerContext } = await import('../server/domains/kernel/context')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => currentSession ? { user: currentSession } : null
  return context
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

async function as(user: typeof admin, fn: () => Promise<void>) {
  currentSession = user
  try { await fn() } finally { currentSession = admin }
}

const idMap = new Map<string, string>() // logical id -> real uuid

async function mkEmployee(logical: string, name: string, email: string, supervisorLogical: string[] = []): Promise<string> {
  const supervisorIds = supervisorLogical.map(s => idMap.get(s)!)
  const r = await callProc('employees.create', { name, email, kind: 'human', title: 'T', supervisorIds })
  idMap.set(logical, r.id)
  return r.id
}

async function mkTask(input: Record<string, unknown>): Promise<string> {
  const r = await callProc('tasks.create', input)
  return r.id
}

/** move task to doing (the assignee picked it up) */
async function startWork(taskId: string) {
  await callProc('tasks.update', { id: taskId, status: 'doing' })
}

async function getTask(id: string) {
  const { db } = await dbm()
  const { tasks } = await schema()
  const rows = await db.select().from(tasks)
  return rows.find(t => t.id === id)!
}

async function activity(id: string) {
  const iter = await callProc('tasks.activity', { taskId: id })
  const snap = await iter.next()
  await iter.return?.()
  return snap.value as any[]
}

beforeEach(async () => {
  currentSession = admin
  idMap.clear()
  await resetSchema()
  await applyMigrations()
  const { db } = await dbm()
  const { user } = await schema()
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
})

describe('task workflow — question chain', () => {
  it('ask moves the task to waiting-answer and routes to the owner (not supervisor)', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('sup', 'Sup', 'sup@tandem.local')
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    const taskId = await mkTask({ title: 'Q task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.ask', { taskId, body: 'which DB?' })
      expect(r.holderId).toBe(idMap.get('owner')!)
    })
    const t = await getTask(taskId)
    expect(t.status).toBe('waiting-answer')
    expect(t.questionHolderId).toBe(idMap.get('owner')!)
  })

  it('holder forwards down the chain; top of the hierarchy cannot be forwarded to', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('top', top.name, top.email) // no supervisors => top
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top'])
    const taskId = await mkTask({ title: 'F task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    // owner forwards to top => refused: top must ANSWER, not receive
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await expect(callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('top')!, body: 'you know' })).rejects.toThrow(/top of the hierarchy/i)
    })
    // owner forwards to someone with a supervisor instead: make a middle employee
    const mid = await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top'])
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      const r = await callProc('tasks.forward', { taskId, toEmployeeId: mid, body: 'mid knows' })
      expect(r.holderId).toBe(mid)
    })
    const t = await getTask(taskId)
    expect(t.questionHolderId).toBe(mid)
    expect(t.questionChain).toEqual([idMap.get('owner')!, mid])
  })

  it('cannot forward to someone already in the chain (loop guard)', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('top', top.name, top.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top'])
    const taskId = await mkTask({ title: 'L task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    const mid = await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top'])
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => { await callProc('tasks.forward', { taskId, toEmployeeId: mid, body: 'to mid' }) })
    await as({ id: mid, name: 'Mid', email: 'mid@tandem.local', role: 'member' }, async () => {
      await expect(callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('owner')!, body: 'back to owner' })).rejects.toThrow(/chain/i)
    })
  })

  it('answer returns the task to the assignee (todo) and clears routing', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    const taskId = await mkTask({ title: 'A task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.answer', { taskId, body: 'use postgres' })
    })
    const t = await getTask(taskId)
    expect(t.status).toBe('todo')
    expect(t.questionHolderId).toBeNull()
    expect(t.questionChain).toEqual([])
    const feed = await activity(taskId)
    expect(feed.map(a => a.kind)).toEqual(['question', 'answer'])
  })

  it('outsider cannot answer', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'X task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.answer', { taskId, body: 'i know' })).rejects.toThrow(/chain/i)
    })
  })
})

describe('task workflow — review gate', () => {
  it('submit with no reviewers completes immediately', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    const taskId = await mkTask({ title: 'S task', assigneeId: idMap.get('worker')! })
    // move to doing first (todo -> doing via update)
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.submit', { taskId, body: 'done it' })
      expect(r.status).toBe('done')
    })
  })

  it('unanimous approval: all reviewers must approve before done', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('rev2', rev2.name, rev2.email)
    const taskId = await mkTask({ title: 'R task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!, idMap.get('rev2')!] })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.submit', { taskId, body: 'result' })
      expect(r.status).toBe('in-review')
    })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      const r = await callProc('tasks.approve', { taskId })
      expect(r.done).toBe(false)
    })
    let t = await getTask(taskId)
    expect(t.status).toBe('in-review')
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      const r = await callProc('tasks.approve', { taskId })
      expect(r.done).toBe(true)
    })
    t = await getTask(taskId)
    expect(t.status).toBe('done')
  })

  it('request-changes sends it back to working and resets approvals', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('rev2', rev2.name, rev2.email)
    const taskId = await mkTask({ title: 'C task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!, idMap.get('rev2')!] })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'v1' }) })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => { await callProc('tasks.approve', { taskId }) })
    let t = await getTask(taskId)
    expect(t.status).toBe('in-review') // rev2 still pending
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => { await callProc('tasks.requestChanges', { taskId, body: 'redo the thing' }) })
    t = await getTask(taskId)
    expect(t.status).toBe('doing')
    // default body arm: submit again, request changes without body
    await startWork(t.id)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId }) })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => { await callProc('tasks.requestChanges', { taskId }) })
    t = await getTask(taskId)
    expect(t.status).toBe('doing')
    expect(t.reviewApprovals).toEqual([])
    const feed = await activity(taskId)
    const verdicts = feed.filter(a => a.kind === 'verdict')
    expect(verdicts.some(v => v.body.includes('redo the thing'))).toBe(true)
  })

  it('non-reviewer cannot approve', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('rev2', rev2.name, rev2.email)
    const taskId = await mkTask({ title: 'N task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'r' }) })
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.approve', { taskId })).rejects.toThrow(/reviewer/i)
    })
  })

  it('reviewer or owner can abandon during review', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'AB task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!], ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'half baked' }) })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => { await callProc('tasks.abandon', { taskId }) })
    const t = await getTask(taskId)
    expect(t.status).toBe('cancelled')
  })

  it('only the assignee can submit', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'O task', assigneeId: idMap.get('worker')! })
    await startWork(taskId)
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.submit', { taskId, body: 'not mine' })).rejects.toThrow(/assignee/i)
    })
  })
})

describe('task workflow — guard rails', () => {
  it('ask fails without an assignee', async () => {
    const taskId = await mkTask({ title: 'NA task' })
    await startWork(taskId)
    await expect(callProc('tasks.ask', { taskId, body: 'anyone?' })).rejects.toThrow(/no assignee/i)
  })

  it('ask outside working is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    const taskId = await mkTask({ title: 'TW task', assigneeId: idMap.get('worker')! })
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.ask', { taskId, body: 'early?' })).rejects.toThrow(/in progress/i)
    })
  })

  it('only the current holder can forward', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'HF task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('rev1')!, body: 'me?' })).rejects.toThrow(/holder/i)
    })
  })

  it('requestChanges by a non-reviewer is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('rev2', rev2.name, rev2.email)
    const taskId = await mkTask({ title: 'RC task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'v1' }) })
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.requestChanges', { taskId, body: 'nope' })).rejects.toThrow(/reviewer/i)
    })
  })

  it('abandon by neither reviewer nor owner is rejected; owner can abandon', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('rev2', rev2.name, rev2.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    const taskId = await mkTask({ title: 'AB2 task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!], ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'x' }) })
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.abandon', { taskId })).rejects.toThrow(/reviewer or the owner/i)
    })
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.abandon', { taskId, body: 'killing it' })
    })
    const t = await getTask(taskId)
    expect(t.status).toBe('cancelled')
  })

  it('requestChanges/abandon outside review are rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'OR task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] })
    await startWork(taskId) // doing, not in review
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.requestChanges', { taskId, body: 'x' })).rejects.toThrow(/not in review/i)
      await expect(callProc('tasks.abandon', { taskId })).rejects.toThrow(/not in review/i)
    })
  })

  it('approve outside review is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'AO task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] })
    await startWork(taskId) // doing — not in review
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.approve', { taskId })).rejects.toThrow(/not in review/i)
    })
  })

  it('ask routes to the creator when no explicit owner (fallback arm)', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    // task created by admin without ownerId — holder must fall back to creator (u-admin)
    const taskId = await mkTask({ title: 'FB task', assigneeId: idMap.get('worker')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.ask', { taskId, body: 'who owns this?' })
      expect(r.holderId).toBe('u-admin')
    })
    // creator (admin) answers — chain includes admin via fallback
    await callProc('tasks.answer', { taskId, body: 'me' })
    const t = await getTask(taskId)
    expect(t.status).toBe('todo')
  })

  it('live shows reviewer names, falling back to raw ids for deleted employees', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    const revId = idMap.get('rev1')!
    const taskId = await mkTask({ title: 'LN task', assigneeId: idMap.get('worker')!, reviewers: [revId, 'u-gone'] })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(r => r.id === taskId)
    expect(row.reviewerNames).toEqual(['Rev One', 'u-gone'])
  })

  it('every workflow proc rejects a missing session', async () => {
    const { appRouter } = await import('../server/domains/app.router')
    const { buildServerContext } = await import('../server/domains/kernel/context')
    const context = buildServerContext(new Headers())
    ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null
    const procs = ['ask', 'forward', 'answer', 'submit', 'approve', 'requestChanges', 'abandon']
    for (const p of procs) {
      const node = (appRouter as any).tasks[p]
      const internals = node['~orpc']
      const base = { taskId: 't-x', toEmployeeId: 'u-x', body: 'x' }
      await expect(internals.handler({ input: base, context, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
  })

  it('update sets ownerId and reviewers together', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    const taskId = await mkTask({ title: 'UO task', assigneeId: idMap.get('worker')! })
    await callProc('tasks.update', { id: taskId, ownerId: idMap.get('owner')!, reviewers: [idMap.get('rev1')!] })
    const t = await getTask(taskId)
    expect(t.ownerId).toBe(idMap.get('owner')!)
    expect(t.reviewers).toEqual([idMap.get('rev1')!])
  })

  it('forward without a note uses empty body', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('top', top.name, top.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top'])
    await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top'])
    const taskId = await mkTask({ title: 'FN task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      const r = await callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('mid')! })
      expect(r.holderId).toBe(idMap.get('mid')!)
    })
    const feed = await activity(taskId)
    expect(feed.some(a => a.kind === 'forward' && a.body === '')).toBe(true)
  })

  it('activity tolerates a null author (system entries)', async () => {
    const { db } = await dbm()
    const { taskActivity } = await schema()
    const taskId = await mkTask({ title: 'SA task' })
    await db.insert(taskActivity).values({ id: 'act-sys', taskId, kind: 'status', authorId: null, body: 'created' })
    const feed = await activity(taskId)
    const sys = feed.find(a => a.id === 'act-sys')
    expect(sys?.authorName).toBeNull()
  })

  it('service guard arms: ghost task, ghost forward target, answer when not waiting', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    // ghost task
    await expect(callProc('tasks.ask', { taskId: 'ghost', body: 'q' })).rejects.toThrow(/task not found/i)
    // ghost forward target (zod bypassed by harness)
    const taskId = await mkTask({ title: 'GA task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.ask', { taskId, body: 'q' }) })
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await expect(callProc('tasks.forward', { taskId, toEmployeeId: 'u-ghost', body: 'x' })).rejects.toThrow(/employee does not exist/i)
    })
    // answer flips to todo; answering AGAIN (not waiting anymore) throws
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.answer', { taskId, body: 'a1' })
      await expect(callProc('tasks.answer', { taskId, body: 'a2' })).rejects.toThrow(/not waiting/i)
    })
  })

  it('abandon falls back to creator when no owner is set', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('rev1', rev1.name, rev1.email)
    // created by admin, ownerId unset -> createdBy fallback arm in abandon
    const taskId = await mkTask({ title: 'CF task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] })
    await startWork(taskId)
    await as({ ...worker, id: idMap.get('worker')! }, async () => { await callProc('tasks.submit', { taskId, body: 'x' }) })
    await callProc('tasks.abandon', { taskId, body: 'by creator' }) // admin session = creator
    const t = await getTask(taskId)
    expect(t.status).toBe('cancelled')
  })

  it('ask with no owner and no creator fails; forward only while waiting', async () => {
    const { db } = await dbm()
    const { tasks } = await schema()
    await mkEmployee('worker', worker.name, worker.email)
    // raw row: nobody owns it (ownerId null, createdBy null)
    await db.insert(tasks).values({ id: 't-orphan', title: 'orphan', description: '', status: 'doing', assigneeId: idMap.get('worker')!, ownerId: null, createdBy: null })
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.ask', { taskId: 't-orphan', body: 'anyone?' })).rejects.toThrow(/no owner/i)
    })
    // forward while NOT waiting (status doing)
    const taskId = await mkTask({ title: 'FW task', assigneeId: idMap.get('worker')! })
    await startWork(taskId)
    await callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('worker')!, body: 'x' }).catch(() => {})
    await expect(callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('worker')!, body: 'x' })).rejects.toThrow(/not waiting/i)
  })

  it('create rejects a ghost assignee; live maps ai assignee + null fields', async () => {
    const { db } = await dbm()
    const { environments } = await schema()
    await expect(callProc('tasks.create', { title: 'GA2', assigneeId: 'u-ghost' })).rejects.toThrow(/assignee does not exist/i)
    // AI employee via API (kind ai, with environment)
    await db.insert(environments).values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '22', username: 'u' })
    const r = await callProc('employees.create', { name: 'Robo', email: 'robo@tandem.local', kind: 'ai', title: 'Bot', supervisorIds: [], environmentId: 'env-1' })
    const taskId = await mkTask({ title: 'AI task', assigneeId: r.id })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(x => x.id === taskId)
    expect(row.assigneeKind).toBe('ai')
    expect(row.projectName).toBeNull()
    expect(row.assigneeName).toBe('Robo')
  })

  it('live maps a fully-empty row (no project/assignee/owner)', async () => {
    const taskId = await mkTask({ title: 'Empty row' })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(r => r.id === taskId)
    expect(row).toMatchObject({ projectId: null, projectName: null, assigneeId: null, assigneeName: null, assigneeKind: null, ownerId: 'u-admin', ownerName: 'Admin', reviewers: [], reviewerNames: [], reviewApprovals: [], questionHolderId: null, questionHolderName: null })
  })

  it('live handles raw rows: null owner, held question', async () => {
    const { db } = await dbm()
    const { tasks } = await schema()
    await mkEmployee('worker', worker.name, worker.email)
    await mkEmployee('owner', ownerUser.name, ownerUser.email)
    // raw row with null owner (bypasses create defaults)
    await db.insert(tasks).values({ id: 't-raw', title: 'raw', description: '', status: 'waiting-answer', assigneeId: idMap.get('worker')!, ownerId: null, createdBy: null, questionHolderId: idMap.get('owner')! })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(r => r.id === 't-raw')
    expect(row.ownerId).toBeNull()
    expect(row.ownerName).toBeNull()
    expect(row.questionHolderName).toBe('Owner')
  })

  it('create without a session leaves owner/creator null', async () => {
    const { appRouter } = await import('../server/domains/app.router')
    const { buildServerContext } = await import('../server/domains/kernel/context')
    const context = buildServerContext(new Headers())
    ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null
    const node = (appRouter as any).tasks.create
    const r = await node['~orpc'].handler({ input: { title: 'NoSession task' }, context, signal: new AbortController().signal })
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(x => x.id === r.id)
    expect(row.ownerId).toBeNull()
    expect(row.createdBy).toBeNull()
  })

  it('submit outside working is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email)
    const taskId = await mkTask({ title: 'SW task', assigneeId: idMap.get('worker')! })
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.submit', { taskId, body: 'not yet' })).rejects.toThrow(/in progress/i)
    })
  })
})

describe('task workflow — status transitions', () => {
  it('waiting-answer and in-review statuses are wired into the flow', async () => {
    const { db } = await dbm()
    const { taskStatuses } = await schema()
    const rows = await db.select().from(taskStatuses)
    const todo = rows.find(r => r.id === 'todo')!
    const doing = rows.find(r => r.id === 'doing')!
    const wa = rows.find(r => r.id === 'waiting-answer')!
    const ir = rows.find(r => r.id === 'in-review')!
    expect(todo.nextIds).toContain('doing')
    expect(doing.nextIds).toContain('waiting-answer')
    expect(doing.nextIds).toContain('in-review')
    expect(doing.nextIds).toContain('done')
    expect(ir.nextIds).toContain('done')
    expect(wa.nextIds).toContain('doing')
  })

  it('create defaults owner to creator; reviewers stored', async () => {
    await mkEmployee('rev1', rev1.name, rev1.email)
    const taskId = await mkTask({ title: 'D task', reviewers: [idMap.get('rev1')!] })
    const t = await getTask(taskId)
    expect(t.ownerId).toBe(admin.id)
    expect(t.reviewers).toEqual([idMap.get('rev1')!])
  })
})
