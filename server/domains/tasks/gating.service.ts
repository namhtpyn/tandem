// Parent gating: a parent is blocked while ANY child is open and unblocks when ALL
// children are terminal (done or a cancelled-category status; abandoned was merged into cancelled).
// The flip is DERIVED state — no human action, no drift (user law, 2026-10-15):
//   - children spawn → parent flips to 'blocked' (pre_block_status remembers the old one)
//   - last child lands terminal → parent restores pre_block_status (or 'todo')
//   - recursive by construction: a child isn't complete while ITS children are open,
//     because the same rule keeps that child non-terminal until its own gate lifts.
import { eq, inArray } from 'drizzle-orm';

import { ACTIVITY_KIND } from '#shared/enums';
import { STATUS } from '#shared/status';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskStatuses } from '../../db/schema';
import { logActivity as publishActivity } from './review.service';

export const BLOCKED_STATUS = STATUS.blocked;

// activity rows are notification state, not gating state — they ride the pool db even mid-tx
async function logActivity(taskId: string, body: string, meta: Record<string, unknown> = {}) {
  await publishActivity(taskId, ACTIVITY_KIND.STATUS, null, body, meta);
}

/** status ids whose category is terminal (done | cancelled) */
export async function terminalStatusIds(ex: DbExecutor = db) {
  // seeded categories are lowercase ('done' | 'cancelled'); OBLIGATION_STATUS is a different key space
  const rows = await asDb(ex)
    .select({ id: taskStatuses.id, category: taskStatuses.category })
    .from(taskStatuses)
    .where(inArray(taskStatuses.category, ['done', 'cancelled']));
  return new Set(rows.map((r) => r.id));
}

/**
 * recompute the auto-block for every ancestor of this task. Call after ANY status
 * change on a task (its own transition may release or tighten its parents' gates).
 */
export async function refreshParentGating(taskId: string, ex: DbExecutor = db) {
  const d = asDb(ex);
  const terminal = await terminalStatusIds(ex);
  // gate the task itself, then every ancestor; guard against cycles defensively
  const seen = new Set<string>();
  let cur = await d.query.tasks.findFirst({
    columns: { id: true, status: true, preBlockStatus: true, parentTaskId: true },
    where: { id: { eq: taskId } },
  });
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const children = await d.query.tasks.findMany({
      columns: { status: true },
      where: { parentTaskId: { eq: cur.id } },
      orderBy: { createdAt: 'asc' },
    });
    const open = children.filter((c) => !terminal.has(c.status)).length;
    if (open > 0 && cur.status !== BLOCKED_STATUS) {
      const pre = cur.preBlockStatus ?? cur.status;
      await d
        .update(tasks)
        .set({ status: BLOCKED_STATUS, preBlockStatus: pre, updatedAt: new Date() })
        .where(eq(tasks.id, cur.id));
      await logActivity(cur.id, `auto-blocked: ${open} subtask(s) open`, { autoBlocked: true, open });
    } else if (open === 0 && cur.status === BLOCKED_STATUS && cur.preBlockStatus) {
      const restore = cur.preBlockStatus;
      await d
        .update(tasks)
        .set({ status: restore, preBlockStatus: null, updatedAt: new Date() })
        .where(eq(tasks.id, cur.id));
      await logActivity(cur.id, `unblocked: all subtasks terminal → ${restore}`, {
        autoUnblocked: true,
        restored: restore,
      });
    }
    if (!cur.parentTaskId) break;
    cur = await d.query.tasks.findFirst({
      columns: { id: true, status: true, preBlockStatus: true, parentTaskId: true },
      where: { id: { eq: cur.parentTaskId } },
    });
  }
}

/** does this task have any open children? (review gate: can't submit while true) */
export async function hasOpenChildren(taskId: string) {
  const children = await db.query.tasks.findMany({
    columns: { status: true },
    where: { parentTaskId: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  if (children.length === 0) return false;
  const terminal = await terminalStatusIds();
  return children.some((c) => !terminal.has(c.status));
}
