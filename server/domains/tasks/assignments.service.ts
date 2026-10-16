// Assignee history — append-only ledger of who owned a task and why it moved.
// The current assignee stays denormalized on tandem_tasks; every change flows
// through recordAssignment so the ledger never drifts (user law, 2026-10-15).
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { taskAssignments, tasks } from '../../db/schema'
import { uuidv7 } from '../kernel/ids'

/** close the open row (if any) and open a new one for the new assignee */
export async function recordAssignment(taskId: string, employeeId: string | null, reason: string, actorId: string | null) {
  await db.update(taskAssignments).set({ endedAt: new Date() })
    .where(and(eq(taskAssignments.taskId, taskId), isNull(taskAssignments.endedAt)))
  await db.insert(taskAssignments).values({ id: uuidv7(), taskId, employeeId, reason, actorId })
}

/** full assignment history for a task, newest first */
export async function listAssignments(taskId: string) {
  return db.select().from(taskAssignments)
    .where(eq(taskAssignments.taskId, taskId))
    .orderBy(desc(taskAssignments.startedAt))
}

/** recent distinct assignees of a task (loop guard for [REASSIGN] ping-pong) */
export async function recentAssignees(taskId: string, limit = 2) {
  const rows = await db.select({ employeeId: taskAssignments.employeeId, startedAt: taskAssignments.startedAt, endedAt: taskAssignments.endedAt })
    .from(taskAssignments)
    .where(eq(taskAssignments.taskId, taskId))
    .orderBy(desc(taskAssignments.startedAt))
    .limit(limit)
  return rows.map(r => r.employeeId).filter((e): e is string => Boolean(e))
}

/** assign + write history in one go (keeps the task row and ledger in lockstep) */
export async function assignTask(taskId: string, employeeId: string | null, reason: string, actorId: string | null) {
  await db.update(tasks).set({ assigneeId: employeeId, updatedAt: new Date() }).where(eq(tasks.id, taskId))
  await recordAssignment(taskId, employeeId, reason, actorId)
}
