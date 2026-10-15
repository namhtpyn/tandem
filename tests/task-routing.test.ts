// Task routing — obligations (who acts next), assignee history, subtask gating,
// and proposal confirm flow (user laws, 2026-10-15):
//   - obligations replace question_holder_id / review_approvals; answer MOVES on forward
//   - assignments are an append-only ledger; every assignee change flows through it
//   - parent auto-blocks while any child is open; restores when all children terminal
//   - agents propose ([SUBTASKS]/[REASSIGN]); the confirm flow is the single writer;
//     outside-chain nominations escalate to the agent's supervisor; ping-pong refused
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { makeProcCaller } from './helpers/procs'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { answerHolder, approvalsInRound, approvalsInRoundBatch, openObligations, pendingForUser, spawnObligation } from '../server/domains/tasks/obligations.service'
import { eq } from 'drizzle-orm'
import { recentAssignees } from '../server/domains/tasks/assignments.service'
import { recordProposals } from '../server/domains/tasks/proposals.service'
import { parseRoutingProposals } from '../app/utils/task-thread'

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }
const worker = { id: 'u-worker', name: 'Worker', email: 'worker@tandem.local', role: 'member' }
const peer = { id: 'u-peer', name: 'Peer Person', email: 'peer@tandem.local', role: 'member' }
const report = { id: 'u-report', name: 'Report Guy', email: 'report@tandem.local', role: 'member' }

const procCaller = await makeProcCaller(admin)
const callProc = procCaller as unknown as (path: string, input?: unknown) => Promise<any>
async function as(user: typeof admin, fn: () => Promise<void>) {
  await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(user)
  try { await fn() } finally {
    await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(admin)
  }
}

/** act as a created employee (session id must be the real user row — activity FKs) */
async function asEmp(logical: string, fn: () => Promise<void>) {
  const base = { worker, peer, report }[logical as 'worker' | 'peer' | 'report']!
  await as({ ...base, id: idMap.get(logical)! }, fn)
}

const idMap = new Map<string, string>()

async function mkEmployee(logical: string, name: string, email: string, supervisorLogical: string[] = []): Promise<string> {
  const supervisorIds = supervisorLogical.map(s => idMap.get(s)!)
  const r = await callProc('employees.create', { name, email, kind: 'human', title: 'T', supervisorIds })
  idMap.set(logical, r.id)
  return r.id
}

async function mkTask(input: Record<string, unknown>): Promise<string> {
  return (await callProc('tasks.create', input)).id
}

async function getTask(id: string) {
  const { db } = await import('../server/db')
  const { tasks } = await import('../server/db/schema')
  const rows = await db.select().from(tasks)
  return rows.find(t => t.id === id)!
}

async function dbRow(table: string, id: string) {
  const { db } = await import('../server/db')
  const mod = await import('../server/db/schema')
  const rows = await db.select().from((mod as any)[table])
  return rows.find((r: any) => r.id === id)
}

async function mkProposal(taskId: string, kind: 'subtasks' | 'reassign', payload: unknown) {
  const { db } = await import('../server/db')
  const { taskProposals } = await import('../server/db/schema')
  const id = crypto.randomUUID()
  await db.insert(taskProposals).values({ id, taskId, kind, payload: payload as Record<string, unknown>, status: 'proposed' })
  return id
}

beforeEach(async () => {
  idMap.clear()
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user } = await import('../server/db/schema')
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await mkEmployee('chief', 'Chief Person', 'chief@tandem.local')
  await mkEmployee('worker', worker.name, worker.email, ['chief'])
  await mkEmployee('peer', peer.name, peer.email, ['worker'])
  await mkEmployee('report', report.name, report.email, ['peer'])
  await mkEmployee('solo', 'Solo Person', 'solo@tandem.local')
})

describe('parseRoutingProposals', () => {
  it('parses subtask lists and reassign with reason, ignores prose', () => {
    const out = [
      'Did the analysis.',
      '[SUBTASKS] Draft legal review :: contract clauses :: Peer Person | Fix CSS :: layout bugs :: Report Guy',
      '[REASSIGN] Peer Person — the whole thing is legal work',
      '[RESULT] analysis complete',
    ].join('\n')
    expect(parseRoutingProposals(out)).toEqual([
      { kind: 'subtasks', items: [
        { title: 'Draft legal review', description: 'contract clauses', assigneeName: 'Peer Person' },
        { title: 'Fix CSS', description: 'layout bugs', assigneeName: 'Report Guy' },
      ] },
      { kind: 'reassign', targetName: 'Peer Person', reason: 'the whole thing is legal work' },
    ])
  })

  it('empty titles filtered; missing reason optional; no markers = no proposals', () => {
    expect(parseRoutingProposals('[SUBTASKS] :: desc :: Someone')).toEqual([])
    expect(parseRoutingProposals('[REASSIGN] Nobody')).toEqual([{ kind: 'reassign', targetName: 'Nobody', reason: undefined }])
    expect(parseRoutingProposals('plain output\n[RESULT] done')).toEqual([])
    expect(parseRoutingProposals(null)).toEqual([])
  })
})

describe('obligations', () => {
  it('ask spawns a pending answer obligation; forward MOVES it; answer resolves it', async () => {
    const taskId = await mkTask({ title: 'Q task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! })
    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.ask', { taskId, body: 'which db?' }))
    expect(await answerHolder(taskId)).toBe(idMap.get('peer')!)
    expect((await pendingForUser(idMap.get('peer')!)).map(i => i.taskId)).toContain(taskId)

    await asEmp('peer', () => callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('report')!, body: 'you know' }))
    expect(await answerHolder(taskId)).toBe(idMap.get('report')!)

    await asEmp('report', () => callProc('tasks.answer', { taskId, body: 'postgres' }))
    expect(await answerHolder(taskId)).toBeNull()
  })

  it('review spawns approval obligations; unanimity via pending rows; re-round on request-changes', async () => {
    const taskId = await mkTask({ title: 'R task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!, idMap.get('report')!] })
    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'done' }))
    const t1 = await getTask(taskId)
    expect(t1.status).toBe('in-review')
    expect((await pendingForUser(idMap.get('peer')!)).length).toBe(1)

    await asEmp('peer', () => callProc('tasks.approve', { taskId, body: 'ok' }))
    expect(await approvalsInRound(taskId)).toEqual([idMap.get('peer')!])
    expect((await getTask(taskId)).status).toBe('in-review')

    await asEmp('report', () => callProc('tasks.requestChanges', { taskId, body: 'redo' }))
    expect((await getTask(taskId)).status).toBe('doing')
    // fresh round: peer's earlier approval no longer counts
    expect(await approvalsInRound(taskId)).toEqual([])
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'v2' }))
    await asEmp('peer', () => callProc('tasks.approve', { taskId, body: 'ok2' }))
    await asEmp('report', () => callProc('tasks.approve', { taskId, body: 'ok3' }))
    expect((await getTask(taskId)).status).toBe('done')
  })

  it('inbox lists tasks pending on me with counts', async () => {
    const a = await mkTask({ title: 'A', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! })
    const b = await mkTask({ title: 'B', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! })
    for (const id of [a, b]) {
      await callProc('tasks.update', { id, status: 'doing' })
      await asEmp('worker', () => callProc('tasks.ask', { taskId: id, body: 'q' }))
    }
    let inbox: any
    await asEmp('peer', async () => { inbox = await callProc('tasks.inbox') })
    expect(inbox.items.length).toBe(2)
    expect(inbox.counts).toEqual({ answer: 2 })
  })
})

describe('assignee history', () => {
  it('create, update, and reassign all append to the ledger; current stays denormalized', async () => {
    const taskId = await mkTask({ title: 'H', assigneeId: idMap.get('worker')! })
    expect((await dbRow('taskAssignments', (await listIds(taskId))[0]!)) && (await listIds(taskId)).length).toBe(1)

    await callProc('tasks.update', { id: taskId, assigneeId: idMap.get('peer')! })
    let ids = await listIds(taskId)
    expect(ids.length).toBe(2)
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!)

    const hist = await callProc('tasks.assignments', { taskId })
    expect(hist.items.length).toBe(2)
    expect(hist.items[0].employeeName).toBe('Peer Person')
    expect(hist.items[1].employeeName).toBe('Worker')
    expect(hist.items[1].endedAt).toBeTruthy()
  })

  async function listIds(taskId: string) {
    const rows = await callProc('tasks.assignments', { taskId })
    return rows.items.map((i: any) => i.id) as string[]
  }
})

describe('subtask gating', () => {
  it('parent auto-blocks while children are open and restores when all are terminal', async () => {
    const parentId = await mkTask({ title: 'Parent', assigneeId: idMap.get('worker')! })
    await callProc('tasks.update', { id: parentId, status: 'doing' })
    const c1 = await mkTask({ title: 'C1', parentId, assigneeId: idMap.get('peer')! })
    expect((await getTask(parentId)).status).toBe('blocked')
    expect((await getTask(parentId)).preBlockStatus).toBe('doing')

    await callProc('tasks.update', { id: c1, status: 'doing' })
    await callProc('tasks.update', { id: c1, status: 'done' })
    expect((await getTask(parentId)).status).toBe('doing')
    expect((await getTask(parentId)).preBlockStatus).toBeNull()

    // second round: cancelled counts as terminal again (done was arm one)
    const c2 = await mkTask({ title: 'C2', parentId })
    expect((await getTask(parentId)).status).toBe('blocked')
    await callProc('tasks.update', { id: c2, status: 'cancelled' })
    expect((await getTask(parentId)).status).toBe('doing')
  })

  it('recursive: grandchild keeps the child (and parent) blocked', async () => {
    const root = await mkTask({ title: 'Root' })
    const mid = await mkTask({ title: 'Mid', parentId: root })
    expect((await getTask(root)).status).toBe('blocked')
    await callProc('tasks.update', { id: mid, status: 'doing' })
    const leaf = await mkTask({ title: 'Leaf', parentId: mid })
    expect((await getTask(mid)).status).toBe('blocked')

    await callProc('tasks.update', { id: leaf, status: 'doing' })
    await callProc('tasks.update', { id: leaf, status: 'done' })
    expect((await getTask(mid)).status).toBe('doing')
    await callProc('tasks.update', { id: mid, status: 'done' })
    expect((await getTask(root)).status).toBe('todo')
  })

  it('submit is refused while children are open; subtasks proc lists children', async () => {
    const parentId = await mkTask({ title: 'P2', assigneeId: idMap.get('worker')! })
    await callProc('tasks.update', { id: parentId, status: 'doing' })
    // a raw child row (no router hook) keeps the parent 'doing' so the explicit
    // open-children submit guard is reachable — defense in depth for racing flips
    const { db } = await import('../server/db')
    const { tasks: tasksTable } = await import('../server/db/schema')
    await db.insert(tasksTable).values({ id: 'c-raw', title: 'Open child', description: '', status: 'todo', assigneeId: null, ownerId: null, reviewers: [], parentTaskId: parentId, createdBy: null })
    await expect(asEmp('worker', () => callProc('tasks.submit', { taskId: parentId, body: 'x' }))).rejects.toThrow(/open subtasks/i)
    const c1 = 'c-raw'

    await callProc('tasks.update', { id: c1, status: 'cancelled' })
    await asEmp('worker', async () => { expect(await callProc('tasks.submit', { taskId: parentId, body: 'x' })).toBeTruthy() })
    const st = await callProc('tasks.subtasks', { taskId: parentId })
    expect(st.items.map((i: any) => i.title)).toEqual(['Open child'])
  })
})

describe('proposal confirm flow', () => {
  it('subtasks: within-chain assignee kept; outside-chain escalated to supervisor', async () => {
    const taskId = await mkTask({ title: 'T1', assigneeId: idMap.get('worker')! })
    // worker's chain: chief (above), peer+report (below). 'Solo Person' is unrelated => escalation.
    const pid = await mkProposal(taskId, 'subtasks', { items: [
      { title: 'In chain', description: 'd1', assigneeName: 'Peer Person' },
      { title: 'Outside chain', description: 'd2', assigneeName: 'Solo Person' },
    ] })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    const st = await callProc('tasks.subtasks', { taskId })
    expect(st.items.length).toBe(2)
    const byTitle = new Map(st.items.map((i: any) => [i.title, i]))
    expect(byTitle.get('In chain').assigneeId).toBe(idMap.get('peer')!)
    // outside worker's chain -> escalates to worker's supervisor (chief)
    expect(byTitle.get('Outside chain').assigneeId).toBe(idMap.get('chief')!)
    // parent auto-blocked now
    expect((await getTask(taskId)).status).toBe('blocked')
    const done = await dbRow('taskProposals', pid)
    expect(done.status).toBe('executed')
  })

  it('subtasks: assignee names that do not exist land unassigned', async () => {
    const taskId = await mkTask({ title: 'T2', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'subtasks', { items: [{ title: 'No name' }] })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    const st = await callProc('tasks.subtasks', { taskId })
    expect(st.items[0].assigneeId).toBeNull()
  })

  it('reassign: within chain goes through with history; ping-pong refused', async () => {
    const taskId = await mkTask({ title: 'T3', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person', reason: 'their domain' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!)
    expect(await recentAssignees(taskId, 2)).toContain(idMap.get('peer')!)

    // peer is now assignee; proposing reassign BACK to worker (recent) is refused
    const back = await mkProposal(taskId, 'reassign', { targetName: 'Worker', reason: 'back' })
    await expect(callProc('tasks.confirmProposal', { proposalId: back })).rejects.toThrow(/loop guard/i)
  })

  it('reassign: unknown employee rejected; double-confirm rejected; reject keeps task and rides the brief', async () => {
    const taskId = await mkTask({ title: 'T4', assigneeId: idMap.get('worker')! })
    const bad = await mkProposal(taskId, 'reassign', { targetName: 'Ghost', reason: 'x' })
    await expect(callProc('tasks.confirmProposal', { proposalId: bad })).rejects.toThrow(/not found/i)

    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person', reason: 'r' })
    await callProc('tasks.rejectProposal', { proposalId: pid, note: 'stay on it' })
    expect((await dbRow('taskProposals', pid)).status).toBe('rejected')
    // decided proposals cannot be confirmed
    await expect(callProc('tasks.confirmProposal', { proposalId: pid })).rejects.toThrow(/already decided/i)

    const { loadBriefData, buildBrief } = await import('../server/domains/tasks/brief.service')
    const data = await loadBriefData(taskId)
    const brief = buildBrief(data)
    expect(brief).toContain('proposal declined')
    expect(brief).toContain('stay on it')
  })

  it('rejected reassign keeps the current assignee', async () => {
    const taskId = await mkTask({ title: 'T5', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person', reason: 'r' })
    await callProc('tasks.rejectProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('worker')!)
  })
})

describe('routing coverage arms', () => {
  it('tasks.proposals lists stored proposals; create with bad parentId rejected', async () => {
    await expect(mkTask({ title: 'X', parentId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const taskId = await mkTask({ title: 'Cov', assigneeId: idMap.get('worker')! })
    await recordProposals(taskId, null as unknown as string, [{ kind: 'subtasks', items: [{ title: 'Only', description: 'd', assigneeName: 'Peer Person' }] }])
    const list = await callProc('tasks.proposals', { taskId })
    expect(list.items.length).toBe(1)
    expect(list.items[0].kind).toBe('subtasks')
    expect(list.items[0].status).toBe('proposed')
  })

  it('reassign escalation: outside-chain target lands on the agent supervisor', async () => {
    const taskId = await mkTask({ title: 'Esc', assigneeId: idMap.get('worker')!, ownerId: idMap.get('chief')! })
    // Solo Person is outside worker's chain (chief above, peer/report below)
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Solo Person', reason: 'their specialty' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!)
    const hist = await callProc('tasks.assignments', { taskId })
    expect(hist.items[0].reason).toContain('escalated')
  })

  it('reassign on an unassigned task writes through directly', async () => {
    const taskId = await mkTask({ title: 'Unassigned' })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!)
  })

  it('reassign without a reason still records', async () => {
    const taskId = await mkTask({ title: 'NoReason', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    const hist = await callProc('tasks.assignments', { taskId })
    expect(hist.items[0].reason).toBe('reassign: ')
  })

  it('spawnObligation is idempotent for identical pending rows', async () => {
    const taskId = await mkTask({ title: 'Idem' })
    const a = await spawnObligation(taskId, idMap.get('peer')!, 'answer')
    const b = await spawnObligation(taskId, idMap.get('peer')!, 'answer')
    expect(a).toBe(b)
  })

  it('pendingCounts splits by role; openObligations batches holders and approvers', async () => {
    const a = await mkTask({ title: 'MultiA', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! })
    const b = await mkTask({ title: 'MultiB', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!] })
    await callProc('tasks.update', { id: a, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.ask', { taskId: a, body: 'q' }))
    await callProc('tasks.update', { id: b, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.submit', { taskId: b, body: 's' }))
    let counts: any
    await asEmp('peer', async () => { counts = await callProc('tasks.inbox') })
    expect(counts.counts).toEqual({ answer: 1, approval: 1 })

    const open = await openObligations([a, b])
    expect(open.get(a)!.holders).toEqual([idMap.get('peer')!])
    expect(open.get(b)!.approvers).toEqual([idMap.get('peer')!])
    expect(await openObligations([])).toBeInstanceOf(Map)

    const approvals = await approvalsInRoundBatch([b])
    expect(approvals.get(b)).toEqual([])
  })

  it('buildBrief renders parent context for children and omits it for roots', async () => {
    const { loadBriefData, buildBrief } = await import('../server/domains/tasks/brief.service')
    const root = await mkTask({ title: 'Root task', assigneeId: idMap.get('worker')! })
    const child = await mkTask({ title: 'Child task', parentId: root, assigneeId: idMap.get('peer')! })
    const childBrief = buildBrief(await loadBriefData(child))
    expect(childBrief).toContain('This is a subtask of: Root task')
    expect(childBrief).toContain('[SUBTASKS]')
    expect(childBrief).toContain('[REASSIGN]')
    const rootBrief = buildBrief({ ...(await loadBriefData(root)), task: { ...((await loadBriefData(root)).task), parentTitle: null } })
    expect(rootBrief).not.toContain('This is a subtask of')
  })

  it('parser: empty segments become undefined; multiple items; reassign without reason', () => {
    expect(parseRoutingProposals('[SUBTASKS] A :: :: Peer Person')).toEqual([
      { kind: 'subtasks', items: [{ title: 'A', description: undefined, assigneeName: 'Peer Person' }] },
    ])
    expect(parseRoutingProposals('[SUBTASKS] B')).toEqual([
      { kind: 'subtasks', items: [{ title: 'B', description: undefined, assigneeName: undefined }] },
    ])
  })
})

describe('routing coverage arms II', () => {
  it('approvalsInRound on a task with no review history is empty; batch cancelled rounds read empty', async () => {
    const fresh = await mkTask({ title: 'Fresh' })
    expect(await approvalsInRound(fresh)).toEqual([])

    const taskId = await mkTask({ title: 'RoundTrip', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!] })
    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'v1' }))
    await asEmp('peer', () => callProc('tasks.requestChanges', { taskId, body: 'no' }))
    const batch = await approvalsInRoundBatch([taskId])
    expect(batch.get(taskId)).toEqual([])
  })

  it('confirm/reject guard unknown ids, decided rows, and vanished tasks', async () => {
    await expect(callProc('tasks.confirmProposal', { proposalId: 'ghost' })).rejects.toThrow(/not found/i)
    await expect(callProc('tasks.rejectProposal', { proposalId: 'ghost' })).rejects.toThrow(/not found/i)

    const taskId = await mkTask({ title: 'Gone', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person', reason: 'r' })
    await callProc('tasks.rejectProposal', { proposalId: pid })
    await expect(callProc('tasks.rejectProposal', { proposalId: pid })).rejects.toThrow(/already decided/i)

  })

  it('confirm refuses unknown proposal kinds', async () => {
    const taskId = await mkTask({ title: 'Kindless', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'nonsense', {})
    await expect(callProc('tasks.confirmProposal', { proposalId: pid })).rejects.toThrow(/unknown proposal kind/i)
  })

  it('reassign outside chain with no supervisor falls through to the loop guard / direct write', async () => {
    // solo has no supervisor: escalation block skipped entirely
    const taskId = await mkTask({ title: 'Lonely', assigneeId: idMap.get('solo')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Peer Person', reason: 'help' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!)
  })

  it('reassign to the supervisor itself skips the escalation write but still lands on the supervisor', async () => {
    const taskId = await mkTask({ title: 'ToSup', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Chief Person', reason: 'above me' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!)
  })

  it('subtasks proposal with no items executes as a no-op; owner fallbacks cover cleared owners', async () => {
    const taskId = await mkTask({ title: 'NoItems', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'subtasks', {})
    await callProc('tasks.confirmProposal', { proposalId: pid })
    const st = await callProc('tasks.subtasks', { taskId })
    expect(st.items.length).toBe(0)

    // escalation with NO supervisor (solo) falls back to the task owner
    const owned = await mkTask({ title: 'OwnFall', assigneeId: idMap.get('solo')!, ownerId: idMap.get('chief')! })
    const oid = await mkProposal(owned, 'subtasks', { items: [{ title: 'Far', assigneeName: 'Peer Person' }] })
    await callProc('tasks.confirmProposal', { proposalId: oid })
    const st2 = await callProc('tasks.subtasks', { taskId: owned })
    expect(st2.items[0].assigneeId).toBe(idMap.get('chief')!)

    // owner cleared entirely -> createdBy fallback
    const { db } = await import('../server/db')
    const { tasks: tasksTable } = await import('../server/db/schema')
    const createdBy = await db.update(tasksTable).set({ ownerId: null }).where(eq(tasksTable.id, owned)).returning()
    expect(createdBy.length).toBe(1)
    const cid = await mkProposal(owned, 'subtasks', { items: [{ title: 'Far2', assigneeName: 'Report Guy' }] })
    await callProc('tasks.confirmProposal', { proposalId: cid })
    const st3 = await callProc('tasks.subtasks', { taskId: owned })
    expect(st3.items.map((i: any) => i.title)).toContain('Far2')
  })

  it('escalated reassign without a reason still executes', async () => {
    const taskId = await mkTask({ title: 'EscNoReason', assigneeId: idMap.get('worker')! })
    const pid = await mkProposal(taskId, 'reassign', { targetName: 'Solo Person' })
    await callProc('tasks.confirmProposal', { proposalId: pid })
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!)
    const hist = await callProc('tasks.assignments', { taskId })
    expect(hist.items[0].reason).toContain('reassign:')
  })

  it('recordProposals reassign summary includes the reason', async () => {
    const taskId = await mkTask({ title: 'ReasonSum' })
    await recordProposals(taskId, null as unknown as string, [{ kind: 'reassign', targetName: 'Peer Person', reason: 'legal work' }])
    const { db } = await import('../server/db')
    const { taskActivity } = await import('../server/db/schema')
    const acts = await db.select().from(taskActivity)
    expect(acts.some(a => a.body!.includes('legal work'))).toBe(true)
  })

  it('live payload skips holders for approval-only tasks (in-review snapshot)', async () => {
    const taskId = await mkTask({ title: 'ApproveOnly', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!] })
    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 's' }))
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    const rows = (snap.value as any).rows ?? snap.value
    const mine = rows.find((r: any) => r.id === taskId)
    expect(mine.questionHolderId).toBeNull()
    expect(mine.reviewApprovals).toEqual([])
    await iter.return?.()
  })

  it('recordProposals logs a reassign summary without reason; live payload exposes holder and approvals', async () => {
    const taskId = await mkTask({ title: 'Live', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')!, reviewers: [idMap.get('report')!] })
    await recordProposals(taskId, null as unknown as string, [{ kind: 'reassign', targetName: 'Peer Person' }])

    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.ask', { taskId, body: 'q' }))
    await asEmp('peer', () => callProc('tasks.answer', { taskId, body: 'a' }))
    await callProc('tasks.update', { id: taskId, status: 'doing' })
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 's' }))
    await asEmp('report', () => callProc('tasks.approve', { taskId, body: 'ok' }))

    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    const rows = (snap.value as any).rows ?? snap.value
    const mine = rows.find((r: any) => r.id === taskId)
    expect(mine.reviewApprovals).toEqual([idMap.get('report')!])
    expect(mine.parentTaskId).toBeNull()
    await iter.return?.()
  })

  it('assignment with a null employee renders an unnamed ledger row', async () => {
    const taskId = await mkTask({ title: 'NullAssign', assigneeId: idMap.get('peer')! })
    await callProc('tasks.update', { id: taskId, assigneeId: null })
    const hist = await callProc('tasks.assignments', { taskId })
    expect(hist.items[0].employeeName).toBeNull()
    expect(hist.items[0].endedAt).toBeNull()
    expect(hist.items[1].endedAt).toBeTruthy()
  })
})
