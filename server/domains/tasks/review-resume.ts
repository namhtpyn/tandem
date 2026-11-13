// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): an owner status move back into
// an IN-REVIEW-CATEGORY status with a live round re-dispatches the parked
// reviewer's turn. Kept as its own leaf module so the router branch is
// unit-pinned: the seeded-id version silently skipped a custom in-review target
// and wedged the round with a PENDING row and no run.
// REQUEUE HEAL (SPEC #440): the same move over a round that CANNOT decide — a
// decided round, or no round at all — used to strand the task: the review box
// renders, nothing can ever mint, and a second same-status move is a refused
// self-edge. The heal opens a FRESH round on the task's stored roster,
// submit-faithful (existence re-checked; zero survivors completes exactly as
// submit's own zero-reviewer arm does — open-subtasks gate included), keeping
// the OWNER'S chosen status id, and the post-flip window is submit-isolated
// (#394 r6): a re-gate failure never skips the reviewer turn, a dispatch
// failure parks rearmable.
import { consola } from 'consola';
import { and, eq } from 'drizzle-orm';

import { ACTIVITY_KIND, CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

import { db } from '../../db/index';
import { taskReviews, tasks } from '../../db/schema';
import { hasOpenChildren, refreshParentGating } from './gating.service';
import {
  canonicalStoredUuid,
  currentRound,
  discardVoidRows,
  dispatchAiReviewTurns,
  liveReviewers,
  logActivity,
  openReviewRound,
  openRoundLive,
  parkRound,
  settleExtinguishedRound,
  teardownAllPendingRounds,
} from './review.service';

const log = consola.withTag('tandem');

/** submit's skip-note arithmetic (UUID-CASE LAW): distinct stored entries that no
 * longer name a company user are skips — case variants of ONE id are the same
 * reviewer, never a skip. */
function skippedCount(roster: string[], liveCount: number, droppedInRound = 0): number {
  const distinct = new Set(roster.map((id) => canonicalStoredUuid(id) ?? id.trim().toLowerCase())).size;
  return Math.max(0, distinct - liveCount + droppedInRound);
}

/** the heal's precondition beyond openRoundLive (SPEC #440): the current round must
 * be DECIDED — an ESCALATED row is a live human verdict the heal must never mint
 * over (round 0 has no rows and heals; a live/void PENDING row is openRoundLive's
 * call, not this one's). */
async function roundEscalated(taskId: string): Promise<boolean> {
  const round = await currentRound(taskId);
  if (round === 0) return false;
  const rows = await db
    .select({ status: taskReviews.status })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  return rows.some((r) => r.status === REVIEW_STATUS.ESCALATED);
}

/** the zero-survivor completion, submit-faithful (#361 r4/r6, #364): no round may
 * outlive the completion — close every pending round the task still carries and
 * land done, CAS-arbitrated on the stamp the heal read (the open-subtasks HOLD is
 * the heal's, above — nothing reaches here with open children). Returns false (no
 * round) so the caller's return stays "a live round exists". */
async function completeWithoutReviewers(taskId: string, task: { status: string; updatedAt: Date }, skipped: number) {
  const done = await db
    .update(tasks)
    .set({ status: STATUS.done, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
    .returning({ id: tasks.id });
  if (done.length === 0) return false; // a concurrent writer owns the outcome
  await teardownAllPendingRounds(taskId, 'no live reviewers');
  if (skipped > 0) {
    await logActivity(taskId, ACTIVITY_KIND.NOTE, null, `${skipped} reviewer(s) skipped — not in the company`, {
      skippedReviewers: skipped,
    });
  }
  try {
    await refreshParentGating(taskId);
  } catch (e) {
    log.warn(`requeue heal: parent re-gate failed for task ${taskId}:`, e instanceof Error ? e.message : e);
  }
  return false;
}

/** the whole-heal open-subtasks hold (#440): submit never reviews a parent with
 * open subtasks — the heal holds identically: no completion AND no fresh round;
 * a note says why (never a silent dead end: the note is the evidence). True = held. */
async function holdForOpenSubtasks(taskId: string): Promise<boolean> {
  if (!(await hasOpenChildren(taskId))) return false;
  await logActivity(
    taskId,
    ACTIVITY_KIND.NOTE,
    null,
    'review cannot start — resolve open subtasks first, then move into review again',
    {},
  );
  return true;
}

/** the post-flip window, submit-isolated (#394 r6): the round is already the
 * outcome, so each step is isolated and logged — the skip note and the re-gate
 * never skip the reviewer turn, and a dispatch failure parks rearmable so the
 * round is never left live with no run and no marker. */
async function finishWonFlip(taskId: string, round: number, skipped: number) {
  try {
    if (skipped > 0) {
      await logActivity(taskId, ACTIVITY_KIND.NOTE, null, `${skipped} reviewer(s) skipped — not in the company`, {
        skippedReviewers: skipped,
      });
    }
  } catch (e) {
    log.warn(`requeue heal: skip note failed for task ${taskId}:`, e instanceof Error ? e.message : e);
  }
  try {
    await refreshParentGating(taskId);
  } catch (e) {
    log.warn(`requeue heal: parent re-gate failed for task ${taskId}:`, e instanceof Error ? e.message : e);
  }
  try {
    await dispatchAiReviewTurns(taskId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.warn(`requeue heal: round ${round} dispatch failed for task ${taskId}:`, reason);
    await parkRound(taskId, `review turn dispatch failed — ${reason}`, { rearmable: true }).catch(() => {});
  }
}

/** REQUEUE HEAL (#440): open a fresh round on the task's stored roster over a
 * decided / never-opened round, keeping the owner's chosen status id. Zero live
 * reviewers completes exactly as submit's zero-reviewer arm does (owner ruling
 * 2026-10-26). FAULT ISOLATED: the owner's move already landed, so a failed heal
 * logs and leaves the shape to the owner — the probe stays silent on it, the
 * owner's status row is the evidence. */
async function healRequeue(taskId: string): Promise<boolean> {
  try {
    const task = await db.query.tasks.findFirst({
      columns: { status: true, updatedAt: true, reviewers: true },
      where: { id: { eq: taskId } },
    });
    if (!task) return false;
    // a concurrent writer may have moved the task between the router's commit and
    // this read: the heal only ever acts on an in-review-category landing
    const catRows = await db.query.taskStatuses.findMany({
      columns: { category: true },
      where: { id: { eq: task.status } },
    });
    if (catRows[0]?.category !== CATEGORY.IN_REVIEW) return false;
    // a concurrent writer may have opened a live round (a racing move's own heal):
    // never mint a stacked round over one
    if (await openRoundLive(taskId)) return false;
    // an ESCALATED row is a live human decision — the heal never mints over it
    if (await roundEscalated(taskId)) return false;
    if (await holdForOpenSubtasks(taskId)) return false;
    const roster = task.reviewers ?? [];
    const reviewers = await liveReviewers(roster);
    if (reviewers.length === 0) return completeWithoutReviewers(taskId, task, skippedCount(roster, 0));
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
      return completeWithoutReviewers(taskId, task, skippedCount(roster, reviewers.length, opened.dropped.length));
    }
    if (!opened.flipped) return false; // a concurrent settle/submit owns the outcome
    // submit's skip note rides the WON flip too — absent ids drop on the fresh
    // round exactly as they do on submit's own round-open (#361 r4)
    await finishWonFlip(taskId, opened.round, skippedCount(roster, reviewers.length, opened.dropped.length));
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
