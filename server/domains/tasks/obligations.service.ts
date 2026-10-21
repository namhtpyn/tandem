// Pending obligations — the single source for "who acts next" on a task.
// Roles today: OBLIGATION_ROLE.ANSWER (question chain), OBLIGATION_ROLE.APPROVAL (unanimous review gate).
// Drives the waiting-on-you inbox + badge. Laws (user, 2026-10-15):
//   - replaces question_holder_id and review_approvals
//   - the answer obligation MOVES on forward (old row cancelled, new row pending)
//   - approvals re-round on request-changes (old rows cancelled, fresh rows spawned)
import { and, desc, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { OBLIGATION_ROLE, OBLIGATION_STATUS, type ObligationRole } from '#shared/enums';

import { db } from '../../db';
import { tasks, taskObligations } from '../../db/schema';

function id() {
  return uuidv7();
}

/** spawn a pending obligation; no-op if an identical pending row already exists */
export async function spawnObligation(taskId: string, employeeId: string, role: ObligationRole, at?: Date) {
  const existing = await db
    .select({ id: taskObligations.id })
    .from(taskObligations)
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.employeeId, employeeId),
        eq(taskObligations.role, role),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    );
  if (existing.length > 0) return existing[0]!.id;
  const rowId = id();
  await db
    .insert(taskObligations)
    .values(
      at
        ? { id: rowId, taskId, employeeId, role, status: OBLIGATION_STATUS.PENDING, createdAt: at }
        : { id: rowId, taskId, employeeId, role, status: OBLIGATION_STATUS.PENDING },
    );
  return rowId;
}

/** mark the pending obligation fulfilled (resolved_by records who acted) */
export async function resolveObligation(
  taskId: string,
  employeeId: string,
  role: ObligationRole,
  resolvedBy: string | null,
) {
  await db
    .update(taskObligations)
    .set({ status: OBLIGATION_STATUS.FULFILLED, resolvedAt: new Date(), resolvedBy })
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.employeeId, employeeId),
        eq(taskObligations.role, role),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    );
}

/** cancel every pending obligation of a role on a task (review re-round, answer reset) */
export async function cancelObligations(taskId: string, role: ObligationRole) {
  await db
    .update(taskObligations)
    .set({ status: OBLIGATION_STATUS.CANCELLED, resolvedAt: new Date() })
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.role, role),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    );
}

/** cancel EVERY obligation of a role on a task — including ones already resolved this
 * round (REVIEW LAW: a change_requested/rejected round must not read as approvals) */
export async function cancelAllObligations(taskId: string, role: ObligationRole) {
  await db
    .update(taskObligations)
    .set({ status: OBLIGATION_STATUS.CANCELLED, resolvedAt: new Date() })
    .where(and(eq(taskObligations.taskId, taskId), eq(taskObligations.role, role)));
}

/** who currently owes the answer (the moved holder), or null */
export async function answerHolder(taskId: string) {
  const rows = await db
    .select({ employeeId: taskObligations.employeeId })
    .from(taskObligations)
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.role, OBLIGATION_ROLE.ANSWER),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    )
    .orderBy(desc(taskObligations.createdAt));
  return rows[0]?.employeeId ?? null;
}

/** fulfilled approvals in the current round = the latest spawned batch.
 *  A round whose rows are all cancelled (request-changes / abandon) is dead → []. */
/** remaining pending approvers for the current round */
/** fulfilled approvals per task for the LATEST round each (batch, for list payloads) */
export async function approvalsInRoundBatch(taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, string[]>();
  const rows = await db
    .select()
    .from(taskObligations)
    .where(and(inArray(taskObligations.taskId, taskIds), eq(taskObligations.role, OBLIGATION_ROLE.APPROVAL)));
  const byTask = new Map<string, typeof rows>();
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out = new Map<string, string[]>();
  for (const [tid, list] of byTask) {
    const latest = Math.max(...list.map((r) => r.createdAt.getTime()));
    const roundRows = list.filter((r) => r.createdAt.getTime() === latest);
    if (roundRows.some((r) => r.status === OBLIGATION_STATUS.CANCELLED)) {
      out.set(tid, []);
      continue;
    }
    out.set(
      tid,
      roundRows.filter((r) => r.status === OBLIGATION_STATUS.FULFILLED).map((r) => r.employeeId!),
    );
  }
  return out;
}

/** the inbox: tasks with a pending obligation on me (any role), newest first */
export async function pendingForUser(employeeId: string) {
  return db
    .select({
      taskId: taskObligations.taskId,
      role: taskObligations.role,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskObligations)
    .innerJoin(tasks, eq(tasks.id, taskObligations.taskId))
    .where(and(eq(taskObligations.employeeId, employeeId), eq(taskObligations.status, OBLIGATION_STATUS.PENDING)))
    .orderBy(desc(taskObligations.createdAt));
}

/** pending obligation counts by role for one user (badge) */
export async function pendingCounts(employeeId: string) {
  const rows = await db
    .select({ role: taskObligations.role })
    .from(taskObligations)
    .where(and(eq(taskObligations.employeeId, employeeId), eq(taskObligations.status, OBLIGATION_STATUS.PENDING)));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.role] = (counts[r.role] ?? 0) + 1;
  return counts;
}

/** open obligations for a task (pending rows only), for the task payload */
export async function openObligations(taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, { holders: string[]; approvers: string[] }>();
  const rows = await db
    .select()
    .from(taskObligations)
    .where(and(inArray(taskObligations.taskId, taskIds), eq(taskObligations.status, OBLIGATION_STATUS.PENDING)));
  const map = new Map<string, { holders: string[]; approvers: string[] }>();
  for (const r of rows) {
    const entry = map.get(r.taskId) ?? { holders: [], approvers: [] };
    if (r.role === OBLIGATION_ROLE.ANSWER && r.employeeId) entry.holders.push(r.employeeId);
    if (r.role === OBLIGATION_ROLE.APPROVAL && r.employeeId) entry.approvers.push(r.employeeId);
    map.set(r.taskId, entry);
  }
  return map;
}
