// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): an owner status move back into
// an IN-REVIEW-CATEGORY status with a live round re-dispatches the parked
// reviewer's turn. Kept as its own leaf module so the router branch is
// unit-pinned: the seeded-id version silently skipped a custom in-review target
// and wedged the round with a PENDING row and no run.
import { CATEGORY } from '#shared/enums';

import { db } from '../../db/index';
import { dispatchAiReviewTurns, openRoundLive, settleExtinguishedRound } from './review.service';

export async function resumeRoundAfterManualMove(taskId: string, targetStatusId: string): Promise<boolean> {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: targetStatusId } },
  });
  // only an in-review landing owns the round; any other target is the owner's
  // resolution and must never re-fire a reviewer
  if (statuses.find((s) => s.id === targetStatusId)?.category !== CATEGORY.IN_REVIEW) return false;
  if (!(await openRoundLive(taskId))) {
    // a round whose only remaining voter was deleted (void pending row) cannot
    // resume: settle it by the normal matrix instead of stranding the task
    // in-review with nothing to decide (#365). No-op on round-0 / decided rounds.
    await settleExtinguishedRound(taskId);
    return false;
  }
  await dispatchAiReviewTurns(taskId);
  return true;
}
