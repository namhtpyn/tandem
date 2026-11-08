// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): an owner status move back into
// an IN-REVIEW-CATEGORY status with a live round re-dispatches the parked
// reviewer's turn. Kept as its own leaf module so the router branch is
// unit-pinned: the seeded-id version silently skipped a custom in-review target
// and wedged the round with a PENDING row and no run.
import { consola } from 'consola';

import { CATEGORY } from '#shared/enums';

import { db } from '../../db/index';
import { discardVoidRows, dispatchAiReviewTurns, openRoundLive, settleExtinguishedRound } from './review.service';

const log = consola.withTag('tandem');

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
      await discardVoidRows(taskId);
      // a residual LIVE row (a terminal settle that crashed before its teardown still
      // owns a turn) keeps its re-fire; the reopen only suppresses the auto-SETTLE
      if (await openRoundLive(taskId)) await dispatchAiReviewTurns(taskId);
      return false;
    }
  }
  if (!(await openRoundLive(taskId))) {
    // a round whose only remaining voter was deleted (void pending row) cannot
    // resume: settle it by the normal matrix instead of stranding the task
    // in-review with nothing to decide (#365). No-op on round-0 / decided rounds.
    try {
      await settleExtinguishedRound(taskId);
    } catch (e) {
      // FAULT ISOLATION (#365 r6): the owner's move already landed — a heal failure
      // must never 500 it; the boot/removal trigger retries (the void row survives)
      log.warn(`resume: extinguished-round settle failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    return false;
  }
  await dispatchAiReviewTurns(taskId);
  return true;
}
