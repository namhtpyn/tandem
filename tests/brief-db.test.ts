// loadBriefData coverage against the real test DB: users, supervision edges, mentions,
// activity, missing-task error arm.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import './helpers/pg'
import { db } from '../server/db'
import { tasks, user as userTable, aiEmployees, employeeSupervisors, taskActivity, environments } from '../server/db/schema'
import { buildBrief, loadBriefData } from '../server/domains/tasks/brief.service'
import { eq } from 'drizzle-orm'

describe('loadBriefData (real db)', () => {
  let agentId: string
  let chiefId: string
  let peerId: string
  let taskId: string

  beforeEach(async () => {
    const rnd = Math.random().toString(36).slice(2, 8)
    agentId = `brief-a-${rnd}`
    chiefId = `brief-c-${rnd}`
    peerId = `brief-p-${rnd}`
    taskId = `brief-t-${rnd}`
    await db.insert(userTable).values([
      { id: agentId, name: 'Agent One', email: `${agentId}@t.local`, role: 'employee', title: 'Worker' },
      { id: chiefId, name: 'Chief Two', email: `${chiefId}@t.local`, role: 'admin', title: 'Chief' },
      { id: peerId, name: 'Peer Three', email: `${peerId}@t.local`, role: 'employee', title: 'Peer' },
    ])
    await db.insert(environments).values({ id: 'env-x', name: 'brief-env', host: 'brief.invalid', port: 22, username: 'root' })
    await db.insert(aiEmployees).values({ userId: agentId, environmentId: 'env-x', instructions: 'Be terse.', harness: 'hermes', executable: '' })
    await db.insert(employeeSupervisors).values([
      { employeeId: agentId, supervisorId: chiefId },
      { employeeId: peerId, supervisorId: chiefId },
    ])
    await db.insert(tasks).values({ id: taskId, title: 'Do things', description: 'Sync with @Peer Three today', status: 'todo', assigneeId: agentId, ownerId: chiefId })
    await db.insert(taskActivity).values({ id: `act-${rnd}`, taskId, kind: 'status', authorId: chiefId, body: 'dispatched' })
  })

  afterEach(async () => {
    await db.delete(taskActivity).where(eq(taskActivity.taskId, taskId))
    await db.delete(tasks).where(eq(tasks.id, taskId))
    await db.delete(employeeSupervisors).where(eq(employeeSupervisors.employeeId, agentId))
    await db.delete(employeeSupervisors).where(eq(employeeSupervisors.employeeId, peerId))
    await db.delete(aiEmployees).where(eq(aiEmployees.userId, agentId))
    await db.delete(environments).where(eq(environments.id, 'env-x'))
    for (const id of [agentId, chiefId, peerId]) await db.delete(userTable).where(eq(userTable.id, id))
  })

  it('assembles identity, chains, mention chain, activity, task url', async () => {
    const d = await loadBriefData(taskId, 'http://x.local')
    expect(d.agent).toMatchObject({ id: agentId, name: 'Agent One', title: 'Worker', kind: 'ai' })
    expect(d.agentInstructions).toBe('Be terse.')
    expect(d.upChain.map(p => p.id)).toEqual([chiefId])
    expect(d.task.ownerName).toBe('Chief Two')
    expect(d.task.url).toBe(`http://x.local/tasks/${taskId}`)
    // @Peer Three mentioned -> extra chain with their supervisor
    expect(d.extraChains).toHaveLength(1)
    expect(d.extraChains[0]!.person.id).toBe(peerId)
    expect(d.extraChains[0]!.chain.map(p => p.id)).toEqual([chiefId])
    expect(d.recentActivity.at(-1)?.body).toBe('dispatched')
  })

  it('covers long activity truncation, mention name stripping, populated reviewers', async () => {
    const long = 'x'.repeat(300)
    await db.insert(taskActivity).values({ id: taskId + '-long', taskId, kind: 'note', authorId: null, body: long })
    await db.update(tasks).set({ description: `ping @[Peer Three](mention-${peerId}) and [@ label="Chief Two"]`, reviewers: [chiefId] }).where(eq(tasks.id, taskId))
    const d = await loadBriefData(taskId, 'http://x.local')
    const brief = buildBrief(d)
    expect(brief).toContain('…') // long activity truncated
    expect(brief).toContain('Peer Three') // mention link stripped to the bare name
    expect(brief).not.toContain('mention-x') // raw mention id never reaches the agent
    expect(d.task.reviewerNames).toContain('Chief Two')
    // Chief Two is the agent's supervisor: covered by the up-chain, not an extra chain.
    // Peer Three (outside the agent's chain) gets their own chain entry.
    expect(d.extraChains.map(c => c.person.id)).toEqual([peerId])
  })

  it('bare task: no owner/reviewers/activity, unknown mention ids skipped, human assignee', async () => {
    const bareId = taskId + 'b'
    await db.insert(tasks).values({ id: bareId, title: 'Bare', description: '', status: 'todo', assigneeId: chiefId, ownerId: null, reviewers: [] })
    // chief is human: no ai row -> empty instructions
    try {
      const d = await loadBriefData(bareId, 'http://x.local')
      expect(d.agentInstructions).toBe('')
      expect(d.task.ownerName).toBeNull()
      expect(d.task.reviewerNames).toEqual([])
      expect(d.recentActivity).toEqual([])
      expect(d.agent.kind).toBe('human')
      const bare = buildBrief(d)
      expect(bare).not.toContain('Reviewers')
      expect(bare).toContain('Owner: unassigned')
    }
    finally {
      await db.delete(tasks).where(eq(tasks.id, bareId))
    }
  })

  it('link-mention with a non-user id is skipped (bogus id arm)', async () => {
    await db.update(tasks).set({ description: 'see @[Someone](mention-bogus-id) now' }).where(eq(tasks.id, taskId))
    const d = await loadBriefData(taskId, 'http://x.local')
    expect(d.extraChains).toHaveLength(0)
  })

  it('mention id that is not a user is skipped', async () => {
    await db.update(tasks).set({ description: 'cc @Ghost Nobody' }).where(eq(tasks.id, taskId))
    const d = await loadBriefData(taskId, 'http://x.local')
    expect(d.extraChains).toHaveLength(0)
  })

  it('defensive arms: activity by unknown author, null description fallbacks', async () => {
    await db.insert(taskActivity).values({ id: taskId + '-ghost', taskId, kind: 'status', authorId: null, body: 'system did something' })
    try {
      const d = await loadBriefData(taskId, 'http://x.local')
      expect(d.recentActivity.some(a => a.authorName === null)).toBe(true)
    }
    finally {
      await db.delete(taskActivity).where(eq(taskActivity.id, taskId + '-ghost'))
    }
  })

  it('fresh task with no activity: brief omits the activity section; titled owner renders', async () => {
    const freshId = taskId + 'f'
    await db.insert(tasks).values({ id: freshId, title: 'Fresh', description: '', status: 'todo', assigneeId: agentId, ownerId: chiefId, reviewers: [] })
    try {
      const d = await loadBriefData(freshId, 'http://x.local')
      expect(d.recentActivity).toEqual([])
      const brief = buildBrief(d)
      expect(brief).not.toContain('Recent activity')
      expect(d.task.ownerName).toBe('Chief Two')
      expect(d.agent.title).toBe('Worker') // titled agent
    }
    finally {
      await db.delete(tasks).where(eq(tasks.id, freshId))
    }
  })

  it('throws on missing task', async () => {
    await expect(loadBriefData('nope', 'http://x.local')).rejects.toThrow('task not found')
  })
})
