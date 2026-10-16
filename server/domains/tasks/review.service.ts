// REVIEW LAW (2026-10-16): reviews happen ON the task — never a subtask.
// tandem_task_reviews is the single source of truth for per-reviewer verdicts:
//   pending -> approved | change_requested | rejected
//   approved (unanimous) -> task done
//   change_requested      -> task back to assignee (ready), note rides the next brief
//   rejected (HUMAN only) -> task cancelled, terminal
// AI reviewers get a review TURN on the same task (a run row by them); their envelope
// settles the verdict ([RESULT] -> approved, [BLOCKED] -> change_requested).
// Obligations stay as the 'Needs my decision' ping, nothing more.
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { tasks, taskReviews, taskRuns, aiEmployees } from '../../db/schema'
import { spawnObligation, cancelObligations, cancelAllObligations } from './obligations.service'
import { publishChange } from '../kernel/kernel'

export type ReviewVerdict = 'approved' | 'change_requested' | 'rejected'

const TODO_STATUS = 'todo'
const IN_REVIEW_STATUS = 'in-review'
const DONE_STATUS = 'done'
const CANCELLED_STATUS = 'cancelled'

async function logActivity(taskId: string, kind: string, authorId: string | null, body: string, meta: Record<string, unknown>) {
  const { taskActivity } = await import('../../db/schema')
  await db.insert(taskActivity).values({ id: crypto.randomUUID(), taskId, authorId, kind, body, meta })
  await publishChange('taskActivity', 'create')
  await publishChange('tasks', 'update')
}

/** current (max) round for a task; 0 when never reviewed */
export async function currentRound(taskId: string): Promise<number> {
  const rows = await db.select({ round: taskReviews.round }).from(taskReviews).where(eq(taskReviews.taskId, taskId)).orderBy(desc(taskReviews.round)).limit(1)
  return rows[0]?.round ?? 0
}

/** open a fresh review round: one pending row per reviewer + inbox obligations.
 * Called by submitResult. The task parks in-review; AI reviewers get review turns. */
export async function openReviewRound(taskId: string, reviewers: string[], resultBody: string): Promise<number> {
  const round = (await currentRound(taskId)) + 1
  const now = new Date()
  for (const reviewerId of reviewers) {
    await db.insert(taskReviews).values({ id: crypto.randomUUID(), taskId, reviewerId, round, status: 'pending', createdAt: now })
    await spawnObligation(taskId, reviewerId, 'approval', now)
  }
  await logActivity(taskId, 'status', null, `review round ${round} opened — waiting on ${reviewers.length} reviewer(s)`, { reviewRound: round })
  await dispatchAiReviewTurns(taskId, resultBody)
  return round
}

/** is the current round still LIVE (pending reviewers, no bounce/cancel yet)?
 * Drives where an answered question returns: a live review round goes back to
 * in-review, everything else back to todo. */
export async function openRoundLive(taskId: string): Promise<boolean> {
  const round = await currentRound(taskId)
  if (round === 0) return false
  const rows = await db.select().from(taskReviews).where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)))
  return rows.length > 0 && rows.some(r => r.status === 'pending') && !rows.some(r => r.status === 'change_requested' || r.status === 'rejected')
}

/** the submitted result the current round is judging (latest submit activity body) */
async function latestSubmittedBody(taskId: string): Promise<string> {
  const { taskActivity } = await import('../../db/schema')
  const rows = await db.select().from(taskActivity).where(eq(taskActivity.taskId, taskId)).orderBy(desc(taskActivity.createdAt)).limit(50)
  const submitted = rows.find(a => a.kind === 'verdict' && (a.meta as Record<string, unknown> | null)?.submitted)
  /* v8 ignore next -- the submit activity always carries a body in practice */
  return submitted?.body ?? ''
}

/** fire a review TURN on the task itself for every AI reviewer still pending this
 * round without a live run (re-dispatched after a round question is answered).
 * Sessions are per (task, reviewer) — never the assignee's session. */
export async function dispatchAiReviewTurns(taskId: string, resultBody?: string): Promise<void> {
  const round = await currentRound(taskId)
  if (round === 0) return
  const rows = await db.select().from(taskReviews).where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.status, 'pending')))
  const aiRows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees)
  const aiIds = new Set(aiRows.map(r => r.userId))
  const { dispatchTask } = await import('./runner.service')
  const body = resultBody ?? await latestSubmittedBody(taskId)
  for (const row of rows) {
    if (!row.reviewerId || !aiIds.has(row.reviewerId)) continue // human reviewer: the card is enough
    // one LIVE review turn per reviewer: skip while theirs is still running
    const running = (await db.select({ id: taskRuns.id }).from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.employeeId, row.reviewerId), eq(taskRuns.status, 'running')))).length > 0
    if (running) continue
    try {
      await dispatchTask(taskId, 'http://tandem.internal', { reviewBy: row.reviewerId, resultBody: body })
      await logActivity(taskId, 'status', null, `review turn dispatched to reviewer ${row.reviewerId}`, { reviewTurn: true, reviewerId: row.reviewerId, round })
    }
    catch (e) {
      /* v8 ignore next 2 -- best-effort: a review-dispatch failure logs and the human card remains */
      await logActivity(taskId, 'status', null, `review turn failed to dispatch: ${e instanceof Error ? e.message : String(e)}`, { reviewTurnFailed: true, reviewerId: row.reviewerId, round })
    }
  }
}

/** write one reviewer's verdict. Only the current round counts. */
export async function recordVerdict(taskId: string, reviewerId: string, verdict: ReviewVerdict, note: string, source: 'human' | 'ai'): Promise<{ outcome: 'waiting' | 'done' | 'returned' | 'cancelled' }> {
  const round = await currentRound(taskId)
  if (round === 0) throw new Error('task has no open review round')
  const row = (await db.select().from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.reviewerId, reviewerId))))[0]
  if (!row) throw new Error('not a reviewer in the current round')
  if (row.status !== 'pending') throw new Error('verdict already recorded for this round')
  await db.update(taskReviews).set({ status: verdict, note: note || null, decidedAt: new Date(), source }).where(eq(taskReviews.id, row.id))
  const { resolveObligation } = await import('./obligations.service')
  /* v8 ignore next -- the obligation always exists for a verdict author; the
   * catch only guards a race with a concurrent round close */
  await resolveObligation(taskId, reviewerId, 'approval', reviewerId).catch(() => {})

  const roundRows = await db.select().from(taskReviews).where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)))
  const all = roundRows.filter(r => r.status === 'approved')
  const unanimous = roundRows.length > 0 && roundRows.every(r => r.status === 'approved')

  if (verdict === 'rejected') {
    // HUMAN-only terminal verdict: task cancelled, round closed
    await cancelAllObligations(taskId, 'approval')
    await db.update(tasks).set({ status: CANCELLED_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    /* v8 ignore next -- tests always pass a note; the fallback text is defensive */
    await logActivity(taskId, 'verdict', reviewerId, note || 'rejected — task cancelled', { rejected: true, round })
    await publishChange('tasks', 'update')
    return { outcome: 'cancelled' }
  }
  if (verdict === 'change_requested') {
    await cancelAllObligations(taskId, 'approval')
    // back to ready so the assignee resumes with the note riding the next brief
    await db.update(tasks).set({ status: TODO_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    /* v8 ignore next -- tests always pass a note; the fallback text is defensive */
    await logActivity(taskId, 'verdict', reviewerId, note || 'changes requested', { changeRequested: true, round })
    await publishChange('tasks', 'update')
    return { outcome: 'returned' }
  }
  // approved
  if (unanimous) {
    await cancelObligations(taskId, 'approval')
    await db.update(tasks).set({ status: DONE_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    await logActivity(taskId, 'verdict', reviewerId, note || 'approved', { approved: true, unanimous: true, round })
    await publishChange('tasks', 'update')
    return { outcome: 'done' }
  }
  await logActivity(taskId, 'verdict', reviewerId, note || 'approved', { approved: true, round })
  return { outcome: 'waiting' }
}

/** reviews list for the task page checklist */
export async function listReviews(taskId: string) {
  const rows = await db.select().from(taskReviews).where(eq(taskReviews.taskId, taskId)).orderBy(taskReviews.round)
  return rows.map(r => ({ reviewerId: r.reviewerId, round: r.round, status: r.status as ReviewVerdict | 'pending', note: r.note, source: r.source, decidedAt: r.decidedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }))
}
