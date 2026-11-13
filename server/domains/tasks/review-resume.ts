// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): an owner status move back into
// an IN-REVIEW-CATEGORY status with a live round re-dispatches the parked
// reviewer's turn. Kept as its own leaf module so the router branch is
// unit-pinned: the seeded-id version silently skipped a custom in-review target
// and wedged the round with a PENDING row and no run.
// REQUEUE HEAL (SPEC #440): the same move over a round that CANNOT decide — a
// decided round, or no round at all — used to strand the task: the review box
// renders, nothing can ever mint, and a second same-status move is a refused
// self-edge. The heal opens a FRESH round on the task's stored roster,
// submit-faithful (existence re-checked; zero survivors completes exactly as if
// no reviewer were set), keeping the OWNER'S chosen status id.
import { consola } from 'consola';
import { and, eq } from 'drizzle-orm';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

import { db } from '../../db/index';
import { tasks } from '../../db/schema';
import { refreshParentGating } from './gating.service';
import {
  discardVoidRows,
  dispatchAiReviewTurns,
  liveReviewers,
  openReviewRound,
  openRoundLive,
  settleExtinguishedRound,
  teardownAllPendingRounds,
} from './review.service';

const log = consola.withTag('tandem');

/** the zero-survivor completion, submit-faithful (#361 r4/r6, #364): no round may
 * outlive the completion — close every pending round the task still carries and
 * land done, CAS-arbitrated on the stamp the heal read. Returns false (no round)
 * so the caller's return stays "a live round exists". */
async function completeWithoutReviewers(taskId: string, stamp: { status: string; updatedAt: Date }): Promise<boolean> {
  const done = await db
    .update(tasks)
    .set({ status: STATUS.done, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, stamp.status), eq(tasks.updatedAt, stamp.updatedAt)))
    .returning({ id: tasks.id });
  if (done.length === 0) return false; // a concurrent writer owns the outcome
  await teardownAllPendingRounds(taskId, 'no live reviewers');
  await refreshParentGating(taskId);
  return false;
}

/** REQUEUE HEAL (#440): open a fresh round on the task's stored roster over a
 * decided / never-opened round, keeping the owner's chosen status id. Zero live
 * reviewers completes exactly as if no reviewer were set (owner ruling
 * 2026-10-26 — submit's own semantic). FAULT ISOLATED: the owner's move already
 * landed, so a failed heal logs and leaves the shape to the owner — the probe
 * stays silent on it, the owner's status row is the evidence. */
async function healRequeue(taskId: string): Promise<boolean> {
  try {
    const task = await db.query.tasks.findFirst({
      columns: { status: true, updatedAt: true, reviewers: true },
      where: { id: { eq: taskId } },
    });
    if (!task) return false;
    const reviewers = await liveReviewers(task.reviewers ?? []);
    if (reviewers.length === 0) return completeWithoutReviewers(taskId, task);
    const opened = await openReviewRound(
      taskId,
      reviewers,
      '',
      { status: task.status, updatedAt: task.updatedAt },
      // the owner's chosen in-review id — the flip re-lands the SAME status,
      // never the seeded review id (submit's landing, not the heal's)
      task.status,
    );
    if (opened.opened === 0 && !opened.flipped) {
      // every reviewer vanished inside the round-open transaction (#364):
      // nothing was minted and nothing flipped — complete as if none were set
      return completeWithoutReviewers(taskId, task);
    }
    if (!opened.flipped) return false; // a concurrent settle/submit owns the outcome
    // a WON flip: parent gating first, then the reviewer turn — the round-open's
    // caller order (a fresh rearmable park must not read as a blocked round)
    await refreshParentGating(taskId);
    await dispatchAiReviewTurns(taskId);
    return true;
  } catch (e) {
    log.warn(`resume: requeue heal failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

export async function resumeRoundAfterManualMove(
  taskId: string,
  targetStatusId: string,
  fromStatusId?: string,
): Promise<boolean> {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: targetStatusId } },
  });
  // only an in-review landing owns the round; any other target is the owner's
  // resolution and must never re-fire a reviewer
  if (statuses.find((s) => s.id === targetStatusId)?.category !== CATEGORY.IN_REVIEW) return false;
  // REOPENING A SETTLED TASK IS THE OWNER'S CALL: a done/cancelled -> in-review move
  // must never be auto-settled back by the matrix (a stale void row can survive a
  // crash window; the owner's explicit reopen outranks it). The reopen also DISCARDS
  // those void rows, so later boot/removal heals find no machine signature to settle.
  if (fromStatusId) {
    const fromRows = await db.query.taskStatuses.findMany({
      columns: { id: true, category: true },
      where: { id: { eq: fromStatusId } },
    });
    const fromCategory = fromRows.find((s) => s.id === fromStatusId)?.category;
    if (fromCategory === CATEGORY.DONE || fromCategory === CATEGORY.CANCELLED) {
      // a stale void row can survive a crash window; the reopen discards it so
      // later boot/removal heals find no machine signature to settle (#365 r4)
      await discardVoidRows(taskId);
      // a residual LIVE row (a terminal settle that crashed before its teardown still
      // owns a turn) keeps its re-fire; the reopen only suppresses the auto-SETTLE
      if (await openRoundLive(taskId)) {
        await dispatchAiReviewTurns(taskId);
        return false;
      }
      // a reopen over a DECIDED / never-opened round is the same requeue dead end
      // as any other move (#440) — the owner re-entered review on purpose, heal it
      return healRequeue(taskId);
    }
  }
  if (!(await openRoundLive(taskId))) {
    // a round whose only remaining voter was deleted (void pending row) cannot
    // resume: settle it by the normal matrix instead of stranding the task
    // in-review with nothing to decide (#365). A DECIDED / round-0 round falls
    // through to the heal (#440) — the settle no-ops there by design.
    try {
      if (await settleExtinguishedRound(taskId)) return false;
    } catch (e) {
      // FAULT ISOLATION (#365 r6): the owner's move already landed — a heal failure
      // must never 500 it; the boot/removal trigger retries (the void row survives).
      // A settle FAILURE also never heals: the void discriminator owns that shape.
      log.warn(`resume: extinguished-round settle failed for task ${taskId}:`, e instanceof Error ? e.message : e);
      return false;
    }
    return healRequeue(taskId);
  }
  await dispatchAiReviewTurns(taskId);
  return true;
}
