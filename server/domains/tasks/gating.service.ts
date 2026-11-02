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
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskStatuses } from '../../db/schema';
import { logActivity as publishActivity, dispatchAiReviewTurns } from './review.service';

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

/** UNBLOCK RESTORE LAW (#88, 2026-10-31): resolve the pre-block restore target before
 * the write — this write bypasses the setStatus membership guard, so an unknown/malformed
 * id would re-create a dangling tasks.status (the #62 class): it falls back to to-do.
 * A working-category target also restores to to-do: a working status must be backed by
 * a live run and the dispatcher scans ready-category only — restore-to-doing dead-ended
 * the task (prod 9515f3f8 sat stranded 4+ days after its unblock). */
export function resolveRestoreTarget(restoreId: string, known: ReadonlyMap<string, string>): string {
  const category = known.get(restoreId);
  if (!category || category === 'working') return STATUS.todo;
  return restoreId;
}

/** PARK-ORIGIN RESTORE (#202): a review park's own origin is the restore target — the
 * recorded pre-park status (in-review by construction), resolved against task_statuses.
 * An unknown/malformed id falls back to in-review, NEVER to-do: a to-do restore re-enters
 * the ready-category dispatch scan and bypasses the open review round (the #88 demotion
 * law must not eat a parked round). */
export function resolveParkRestoreTarget(parkFrom: string, known: ReadonlyMap<string, string>): string {
  return known.has(parkFrom) ? parkFrom : STATUS.inReview;
}

async function statusCategoryMap(ex: DbExecutor = db): Promise<Map<string, string>> {
  const rows = await asDb(ex).select({ id: taskStatuses.id, category: taskStatuses.category }).from(taskStatuses);
  return new Map(rows.map((r) => [r.id, r.category]));
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
    columns: { id: true, status: true, preBlockStatus: true, parkFromStatus: true, parentTaskId: true },
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
      // pre-block memory: an existing pre_block_status wins; else the park origin
      // (#202 — a parked-but-unblocked-status row restores to its park origin, never
      // to its current status); the block arm never fires on BLOCKED, so the status
      // term below can never record BLOCKED itself
      const pre = cur.preBlockStatus ?? cur.parkFromStatus ?? cur.status;
      await d
        .update(tasks)
        .set({ status: BLOCKED_STATUS, preBlockStatus: pre, updatedAt: new Date() })
        .where(eq(tasks.id, cur.id));
      await logActivity(cur.id, `auto-blocked: ${open} subtask(s) open`, { autoBlocked: true, open });
    } else if (open === 0 && cur.status === BLOCKED_STATUS && (cur.preBlockStatus || cur.parkFromStatus)) {
      // PARK-ORIGIN RESTORE (#202): a parked task (park_from_status set) restores its
      // recorded pre-park status even with no pre_block_status — pure parks stranded
      // here forever before. Park origin outranks a stale pre_block_status (a gate that
      // pre-dated the park); a plain gated unblock keeps the #88 restore law.
      const parked = Boolean(cur.parkFromStatus);
      const known = await statusCategoryMap(ex);
      const restore = parked
        ? resolveParkRestoreTarget(nonNull(cur.parkFromStatus), known)
        : resolveRestoreTarget(nonNull(cur.preBlockStatus), known);
      await d
        .update(tasks)
        .set({ status: restore, preBlockStatus: null, parkFromStatus: null, updatedAt: new Date() })
        .where(eq(tasks.id, cur.id));
      await logActivity(cur.id, `unblocked: all subtasks terminal → ${restore}`, {
        autoUnblocked: true,
        restored: restore,
        ...(parked ? { parkResumed: true } : {}),
      });
      // unblock-resume parity (#202): a restored parked round replays its reviewer turn —
      // a park is no job + rows, so the restore must re-mint the parked turn
      if (parked) await dispatchAiReviewTurns(cur.id);
    }
    if (!cur.parentTaskId) break;
    cur = await d.query.tasks.findFirst({
      columns: { id: true, status: true, preBlockStatus: true, parkFromStatus: true, parentTaskId: true },
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
