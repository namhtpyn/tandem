// Parent gating: a parent is blocked while ANY child is open and unblocks when ALL
// children are terminal (done or a cancelled-category status; abandoned was merged into cancelled).
// The flip is DERIVED state — no human action, no drift (user law, 2026-10-15):
//   - children spawn → parent flips to 'blocked' (pre_block_status remembers the old one)
//   - last child lands terminal → parent restores pre_block_status (or 'todo')
//   - recursive by construction: a child isn't complete while ITS children are open,
//     because the same rule keeps that child non-terminal until its own gate lifts.
import { consola } from 'consola';
import { and, asc, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm';

import { ACTIVITY_KIND, CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskStatuses } from '../../db/schema';
import {
  logActivity as publishActivity,
  dispatchAiReviewTurns,
  openRoundLive,
  settleExtinguishedRound,
  PARK_REARM_LADDER_MS,
} from './review.service';

export const BLOCKED_STATUS = STATUS.blocked;

/** #365: a restore that lands in-review replays a LIVE round's parked turn or settles
 *  an extinguished one (its reviewer was deleted while the task was blocked) — never
 *  leave a round nothing can ever decide. A non-parked restore to in-review replays
 *  nothing (#202 parity: only a park carries a parked turn). MACHINE-CLASS ONLY (#419):
 *  an automatic restore re-fires only a park the ladder owns (park_rearm_attempts > 0) —
 *  a DECISION-class park (a stopped turn, an exhausted escalation, a verdict-less round
 *  after its retry) is the round's own stop and waits for the owner, never for a child
 *  to land. */
async function resumeRestoredRound(taskId: string, resumeTurn: boolean, restoreCategory: string | undefined) {
  // #369: a restore into the QUESTION flow re-runs the answer arm — a holder removed
  // while the task was BLOCKED left its NULL-holder row as the machine signature (the
  // arm never cancels it on a blocked task), and no other path would return it.
  if (restoreCategory === CATEGORY.WAITING_ANSWER) {
    try {
      const { hasOrphanAnswerSignature, returnRemovedAnswerHolderTask } = await import('./review.service');
      // ONLY the machine signature: a legal manual move into a waiting-answer status
      // carries no pending row and must never be flipped out of its flow (#369)
      if (await hasOrphanAnswerSignature(taskId)) await returnRemovedAnswerHolderTask(taskId);
    } catch (e) {
      log.warn(`gating: answer-holder restore heal failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  if (!resumeTurn && restoreCategory !== CATEGORY.IN_REVIEW) return;
  try {
    const roundLive = await openRoundLive(taskId);
    if (resumeTurn && roundLive) await dispatchAiReviewTurns(taskId);
    else if (!roundLive && restoreCategory === CATEGORY.IN_REVIEW) await settleExtinguishedRound(taskId);
  } catch (e) {
    // FAULT ISOLATION (#365 r6): this runs inside refreshParentGating, which every task
    // write awaits — a heal failure must never 500 a write that already landed. The
    // next boot/removal trigger retries the settle (the void row is still there).
    log.warn(`gating: restore-resume failed for task ${taskId}:`, e instanceof Error ? e.message : e);
  }
}

const log = consola.withTag('tandem');

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
    columns: {
      id: true,
      status: true,
      preBlockStatus: true,
      parkFromStatus: true,
      parkRearmAttempts: true,
      parentTaskId: true,
    },
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
      // GUARDED GATING WRITE (#208): one conditional flip — a row that flipped BLOCKED
      // between the read and this write (a park, another gate) wins; zero rows = the
      // concurrent writer owns the outcome and its own thread note
      const gated = await d
        .update(tasks)
        .set({ status: BLOCKED_STATUS, preBlockStatus: pre, updatedAt: new Date() })
        .where(and(eq(tasks.id, cur.id), ne(tasks.status, BLOCKED_STATUS)))
        .returning({ id: tasks.id });
      if (gated.length > 0) {
        await logActivity(cur.id, `auto-blocked: ${open} subtask(s) open`, { autoBlocked: true, open });
      }
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
      // GUARDED GATING WRITE (#208): atomic on the row still being BLOCKED (same
      // pattern as bounceTaskAfterRun) — the statusCategoryMap await above opens a
      // window a concurrent owner settle/unblock can win
      const restored = await d
        .update(tasks)
        .set({ status: restore, preBlockStatus: null, parkFromStatus: null, updatedAt: new Date() })
        .where(and(eq(tasks.id, cur.id), eq(tasks.status, BLOCKED_STATUS)))
        .returning({ id: tasks.id });
      if (restored.length === 0) {
        // the concurrent writer is the verdict of record: no restore, no note, no
        // turn replay, and the walk stops — the winner re-runs refreshParentGating
        // itself (every status write path does), so its outcome propagates upstream
        break;
      }
      await logActivity(cur.id, `unblocked: all subtasks terminal → ${restore}`, {
        autoUnblocked: true,
        restored: restore,
        ...(parked ? { parkResumed: true } : {}),
      });
      // unblock-resume parity (#202) + #365 + #419: replay a restored MACHINE park's
      // turn (the ladder ledger is the persisted class marker), settle a restore that
      // lands in-review with no live voter (leaf helper); a decision park waits for the
      // owner, never for a child to land
      await resumeRestoredRound(cur.id, parked && (cur.parkRearmAttempts ?? 0) > 0, known.get(restore));
    }
    if (!cur.parentTaskId) break;
    cur = await d.query.tasks.findFirst({
      columns: {
        id: true,
        status: true,
        preBlockStatus: true,
        parkFromStatus: true,
        parkRearmAttempts: true,
        parentTaskId: true,
      },
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

// PARK-REARM scan (#211): a parked review round whose infra-class re-arm ladder is due
// re-runs the unblock arm — the one-shot arm fired into an outage once (#211's frozen
// shape), so the tick revisits it. Never rejects (tick-isolation contract); best-effort
// like the sweeps.
export const REARM_SCAN_LIMIT = 5;

export async function rearmParkedRounds(): Promise<number> {
  try {
    return await rearmParkedRoundsInner();
  } catch (e) {
    log.warn('park re-arm scan failed:', e instanceof Error ? e.message : e);
    return 0; // best-effort scan: a failed read just means try again next tick
  }
}

async function rearmParkedRoundsInner(): Promise<number> {
  // the WHERE carries the whole shape in SQL (bounding law): BLOCKED + a scheduled
  // re-arm that is due; decision parks (after null) and exhausted ladders (final
  // park, after null) never match. Partial-index-backed + LIMIT-bounded.
  const due = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(eq(tasks.status, BLOCKED_STATUS), isNotNull(tasks.parkRearmAfter), lte(tasks.parkRearmAfter, new Date())),
    )
    .orderBy(asc(tasks.parkRearmAfter))
    .limit(REARM_SCAN_LIMIT);
  if (due.length === 0) return 0;
  const terminal = await terminalStatusIds();
  let rearmed = 0;
  for (const row of due) {
    // arm precondition first: zero open children. A parked parent whose children are
    // still open re-fires from the child's settle path — defer one ladder step instead
    // of hot-revisiting every tick (no attempt burned: the ladder only advances on a
    // park write).
    const kids = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.parentTaskId, row.id));
    if (kids.some((k) => !terminal.has(k.status))) {
      await db
        .update(tasks)
        .set({ parkRearmAfter: new Date(Date.now() + PARK_REARM_LADDER_MS[0]) })
        .where(and(eq(tasks.id, row.id), eq(tasks.status, BLOCKED_STATUS)));
      continue;
    }
    // the unblock arm owns the flip: guarded restore + re-dispatch of the parked
    // reviewer's turn — the exact one-shot path, revisited
    await refreshParentGating(row.id);
    const after = await db.query.tasks.findFirst({
      columns: { status: true },
      where: { id: { eq: row.id } },
    });
    if (after && after.status !== BLOCKED_STATUS) rearmed += 1;
  }
  if (rearmed > 0) log.info(`park re-arm scan: ${rearmed} parked round(s) re-armed`);
  return rearmed;
}
