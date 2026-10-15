// Task workflow service: question → forward chain → answer, and the review
// gate (submit / approve / request-changes / abandon). Pure routing logic the
// router and (later) the dispatcher both call. Laws (user, 2026-10-13):
//   1. owner ≠ supervisor — no hierarchy coupling
//   2. ALL reviewers must approve
//   3. reviewer/assignee: AI or human, no restriction
//   4. forward chain is free but stops at the top of the hierarchy (no
//      supervisors left) — and can't revisit anyone already in the chain
import { eq, and, asc } from 'drizzle-orm'
import { db } from '../../db'
import { tasks, taskActivity, user as userTable, employeeSupervisors } from '../../db/schema'
import { publishChange } from '../kernel/kernel'
import { spawnObligation, resolveObligation, cancelObligations, answerHolder, pendingApprovers } from './obligations.service'
import { refreshParentGating, hasOpenChildren } from './gating.service'

export const WAITING_ANSWER_STATUS = 'waiting-answer'
export const IN_REVIEW_STATUS = 'in-review'
export const TODO_STATUS = 'todo'
export const DOING_STATUS = 'doing'
export const DONE_STATUS = 'done'

async function logActivity(taskId: string, kind: 'question' | 'answer' | 'forward' | 'note' | 'verdict' | 'status', authorId: string | null, body: string, meta: Record<string, unknown> = {}) {
  await db.insert(taskActivity).values({ id: crypto.randomUUID(), taskId, kind, authorId, body, meta })
  await publishChange('taskActivity', 'create')
  await publishChange('tasks', 'update')
}

async function getTask(id: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id))
  if (rows.length === 0) throw new Error('task not found')
  return rows[0]!
}

async function hasSupervisors(employeeId: string) {
  const rows = await db.select({ supervisorId: employeeSupervisors.supervisorId })
    .from(employeeSupervisors).where(eq(employeeSupervisors.employeeId, employeeId))
  return rows.length > 0
}

/** assignee asks; holder starts as the owner. status → waiting-answer */
export async function askQuestion(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (!task.assigneeId) throw new Error('task has no assignee')
  const holder = task.ownerId ?? task.createdBy
  if (!holder) throw new Error('task has no owner to answer')
  if (task.status !== DOING_STATUS) throw new Error('only a task in progress can ask')
  await cancelObligations(taskId, 'answer')
  await spawnObligation(taskId, holder, 'answer')
  await db.update(tasks).set({
    status: WAITING_ANSWER_STATUS,
    questionChain: [holder],
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'question', authorId, body, { holderId: holder })
  return { holderId: holder }
}

/** current holder forwards to someone new; they become holder. Top of the org must answer. */
export async function forwardQuestion(taskId: string, authorId: string, toEmployeeId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== WAITING_ANSWER_STATUS) throw new Error('task is not waiting for an answer')
  const holder = await answerHolder(taskId)
  if (holder !== authorId) throw new Error('only the current holder can forward')
  const chain = task.questionChain
  if (chain.includes(toEmployeeId)) throw new Error('already in the question chain')
  const target = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, toEmployeeId))
  if (target.length === 0) throw new Error('employee does not exist')
  if (!await hasSupervisors(toEmployeeId)) throw new Error('that person is the top of the hierarchy — they should answer')
  await resolveObligation(taskId, holder!, 'answer', authorId)
  await db.update(tasks).set({
    questionChain: [...chain, toEmployeeId],
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId))
  await spawnObligation(taskId, toEmployeeId, 'answer')
  await logActivity(taskId, 'forward', authorId, body, { toId: toEmployeeId, toName: target[0]!.name })
  return { holderId: toEmployeeId }
}

/** anyone in the chain answers → back to the assignee, status → todo (dispatcher re-fires) */
export async function answerQuestion(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== WAITING_ANSWER_STATUS) throw new Error('task is not waiting for an answer')
  const chain = task.questionChain
  if (!chain.includes(authorId)) throw new Error('only someone in the question chain can answer')
  await cancelObligations(taskId, 'answer')
  await db.update(tasks).set({
    status: TODO_STATUS,
    questionChain: [],
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'answer', authorId, body, {})
  await refreshParentGating(taskId)
  return { ok: true }
}

/** assignee submits the result → in review (reviewers pinged). No reviewers → done. */
export async function submitResult(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== DOING_STATUS) throw new Error('only a task in progress can submit')
  if (task.assigneeId !== authorId) throw new Error('only the assignee can submit')
  if (await hasOpenChildren(taskId)) throw new Error('task has open subtasks — they must be done or abandoned first')
  const reviewers = task.reviewers
  const nextStatus = reviewers.length > 0 ? IN_REVIEW_STATUS : DONE_STATUS
  await cancelObligations(taskId, 'approval')
  const round = new Date() // one timestamp per round — round identity in the ledger
  for (const r of reviewers) await spawnObligation(taskId, r, 'approval', round)
  await db.update(tasks).set({ status: nextStatus, updatedAt: new Date() }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'verdict', authorId, body, { submitted: true, reviewers })
  await refreshParentGating(taskId)
  return { status: nextStatus }
}

/** reviewer approves; unanimous → done */
export async function approveReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review')
  const reviewers = task.reviewers
  if (!reviewers.includes(authorId)) throw new Error('not a reviewer on this task')
  await resolveObligation(taskId, authorId, 'approval', authorId)
  const remaining = await pendingApprovers(taskId)
  const all = remaining.length === 0
  await db.update(tasks).set({
    status: all ? DONE_STATUS : IN_REVIEW_STATUS,
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'verdict', authorId, body || 'approved', { approve: true, unanimous: all })
  await refreshParentGating(taskId)
  return { done: all }
}

/** reviewer requests changes → back to working; approvals reset; feedback = new instruction */
export async function requestChanges(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review')
  const reviewers = task.reviewers
  if (!reviewers.includes(authorId)) throw new Error('not a reviewer on this task')
  await cancelObligations(taskId, 'approval')
  await db.update(tasks).set({ status: DOING_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'verdict', authorId, body, { requestChanges: true })
  await refreshParentGating(taskId)
  return { ok: true }
}

/** reviewer proposes abandon → owner confirms → cancelled (handled by owner via normal status move or this) */
export async function abandonReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId)
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review')
  const reviewers = task.reviewers
  const isReviewer = reviewers.includes(authorId)
  const isOwner = task.ownerId === authorId || task.createdBy === authorId
  if (!isReviewer && !isOwner) throw new Error('only a reviewer or the owner can abandon')
  await cancelObligations(taskId, 'approval')
  await cancelObligations(taskId, 'answer')
  await db.update(tasks).set({ status: 'abandoned', updatedAt: new Date() }).where(eq(tasks.id, taskId))
  await logActivity(taskId, 'verdict', authorId, body || 'abandoned', { abandon: true })
  await refreshParentGating(taskId)
  return { ok: true }
}

/** activity feed for one task, oldest first */
export async function listActivity(taskId: string) {
  return db.select({
    id: taskActivity.id,
    taskId: taskActivity.taskId,
    kind: taskActivity.kind,
    authorId: taskActivity.authorId,
    body: taskActivity.body,
    meta: taskActivity.meta,
    createdAt: taskActivity.createdAt,
  }).from(taskActivity).where(eq(taskActivity.taskId, taskId)).orderBy(asc(taskActivity.createdAt))
}
