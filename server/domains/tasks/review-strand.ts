// RESTORE-STRAND DETECTOR (#500): the RE-KEYED-HOME arm's live-round clause bounds it to a
// round that is ALREADY closed — a status re-keyed while its task sits blocked over a LIVE
// round is invisible to every probe term (a PENDING row on a blocked task is legal, so the
// arm cannot loosen the clause without firing on waiting-answer holds). The drop happens at
// the RESTORE: the children land, resolveRestoreTarget resolves the re-keyed home, the task
// lands outside the review flow and the live round can never settle. This module is the
// detector's decision + the two reads it needs; the gating restore writes the verdict into
// its OWN unblock record (`reviewStrand`, atomic with the note), and the probe's
// RESTORE-STRAND arm surfaces that record.
import { and, desc, eq, gt, inArray, isNotNull, like, sql } from 'drizzle-orm';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';

import { asDb, type DbExecutor } from '../../db/index';
import { taskMessageActivities, taskMessages, taskReviews } from '../../db/schema';

/** A home CATEGORY recorded on a gating note at write time + when that note landed. */
export type HomeRecord = { category: string; at: Date };

/** The block note's record — same shape, but the category can be NULL: a floored note
 *  whose block committed against a home that already named no `task_statuses` row (the
 *  ghost-task race) recorded the ABSENCE, which is a record, not a missing one (#503). */
export type BlockHomeRecord = { category: string | null; at: Date };

const VERDICT_STATUSES = [REVIEW_STATUS.APPROVED, REVIEW_STATUS.CHANGE_REQUESTED, REVIEW_STATUS.REJECTED];

/** The newest `auto-blocked:` note carrying a home record (HOME-CATEGORY RECORD FLOOR,
 *  2.78.41; GHOST-AT-BLOCK RECORD FLOOR, 2.78.44, #503). A pre-floor note carries no
 *  `homeCategory` KEY at all and returns null — the detector stays silent on it, exactly
 *  like the probe arm's pre-floor fallback (the row is the declared #491 residual and must
 *  not be re-labelled by half a record). A floored note whose value is NULL returns a
 *  record with `category: null`: the home was already a ghost at block time. */
export async function newestBlockHomeRecord(taskId: string, ex: DbExecutor): Promise<BlockHomeRecord | null> {
  const rows = await asDb(ex)
    .select({
      category: sql<string | null>`${taskMessageActivities.payload}->>'homeCategory'`,
      keyed: sql<boolean>`jsonb_exists(${taskMessageActivities.payload}, 'homeCategory')`,
      at: taskMessages.createdAt,
    })
    .from(taskMessages)
    .innerJoin(taskMessageActivities, eq(taskMessageActivities.messageId, taskMessages.id))
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        like(taskMessages.body, 'auto-blocked:%'),
        sql`${taskMessageActivities.payload}->>'kind' = 'STATUS'`,
      ),
    )
    .orderBy(desc(taskMessages.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.keyed) return null;
  return { category: row.category === '' ? null : row.category, at: row.at };
}

/** The newest `review parked` note carrying the park home's CATEGORY (PARK-CATEGORY
 *  RECORD FLOOR, 2.78.43, #502). A pre-floor park note carries no `homeCategoryAtPark`
 *  key and returns null — the detector's park half stays silent on it, the declared
 *  residual below the floor (same shape as the block half's pre-floor fallback). */
export async function newestParkHomeRecord(taskId: string, ex: DbExecutor): Promise<HomeRecord | null> {
  const rows = await asDb(ex)
    .select({
      category: sql<string | null>`${taskMessageActivities.payload}->>'homeCategoryAtPark'`,
      at: taskMessages.createdAt,
    })
    .from(taskMessages)
    .innerJoin(taskMessageActivities, eq(taskMessageActivities.messageId, taskMessages.id))
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        like(taskMessages.body, 'review parked —%'),
        sql`${taskMessageActivities.payload}->>'kind' = 'STATUS'`,
      ),
    )
    .orderBy(desc(taskMessages.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.category === null || row.category === '') return null;
  return { category: row.category, at: row.at };
}

/** A verdict NEWER than the block record: the round was live at block time and closed
 *  while the task sat blocked — the settle flip could not land, so the verdict is stranded
 *  too (the #500 sentence's second variant). ANY round, never just max(round): a superseded
 *  max round can hide an older round that is still live (#445's doctrine — the ready-round
 *  arm retired the max-round clause for exactly this shape). */
export async function hasVerdictAfter(taskId: string, at: Date, ex: DbExecutor): Promise<boolean> {
  const rows = await asDb(ex)
    .select({ id: taskReviews.id })
    .from(taskReviews)
    .where(
      and(eq(taskReviews.taskId, taskId), inArray(taskReviews.status, VERDICT_STATUSES), gt(taskReviews.decidedAt, at)),
    )
    .limit(1);
  return rows.length > 0;
}

/** A LIVE reviewer row in ANY round — PENDING with a reviewer (a void row from a removed
 *  reviewer can never carry a verdict and is not a live decision). ANY round by the same
 *  #445 doctrine: a superseded max round must not hide an older owed vote. ADVISORY read —
 *  the caller runs it on the pool, deliberately, so a failed statement can never abort a
 *  borrowed caller's transaction. */
export async function hasLiveReviewRow(taskId: string, ex: DbExecutor): Promise<boolean> {
  const rows = await asDb(ex)
    .select({ id: taskReviews.id })
    .from(taskReviews)
    .where(
      and(
        eq(taskReviews.taskId, taskId),
        eq(taskReviews.status, REVIEW_STATUS.PENDING),
        isNotNull(taskReviews.reviewerId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type RestoreStrandInput = {
  /** the block record's category; null with `ghostAtBlock: false` (no floored record at
   *  all) disables the detector */
  recordedCategory: string | null;
  /** the block record IS floored and names NO category: the block committed against a
   *  home that already named no `task_statuses` row (the ghost-task race). The re-key
   *  test is satisfied by construction — there is no recorded category a current home
   *  could match (#503, GHOST-AT-BLOCK RECORD floor 2.78.44). */
  ghostAtBlock: boolean;
  /** the category the recorded home (pre_block_status) carries NOW — the re-key test's
   *  second term, mirroring the RE-KEYED-HOME arm. Never derived from the landing status:
   *  a WORKING home legally demotes to to-do (#88), so comparing against the landing would
   *  misread every demotion as a re-key. `undefined` = the recorded home no longer
   *  resolves (deleted under the block — the ghost-race producer the SPEC declares for
   *  ORPHAN-HOME; the live-decision variant lands here, ORPHAN-HOME covers the no-PENDING
   *  variant, so the two arms split the shape by declaration). */
  homeCategory: string | undefined;
  /** the category the restore actually lands on (resolveRestoreTarget already applied) */
  landingCategory: string | undefined;
  /** a PENDING reviewer row in the task's max round at restore time */
  liveRound: boolean;
  /** a verdict on the max round NEWER than the block record (landed while blocked) */
  postRecordVerdict: boolean;
};

/** The detector's contract (SPEC "Probe versioning", RESTORE-STRAND): a restore that lands
 *  a task OUTSIDE the in-review category while its recorded block home was re-keyed
 *  (recorded category ≠ the home's CURRENT category) or no longer resolves AND the task
 *  carries a live review decision (a PENDING row, or a verdict newer than the record) is a
 *  strand — the review was requested and can never land. A FLOORED record that names NO
 *  category (the block committed against a ghost home) satisfies the re-key test by
 *  construction — there is no recorded value a current home could match (#503). Every
 *  legal shape is excluded: #423's settle-then-reblock records the already-terminal
 *  category, a manual terminal move keeps the category it blocks from, a legal
 *  working-home demotion records the home it blocks from (equal), a faithful status
 *  re-home keeps the category, and an in-view restore re-enters the flow. */
export function isRestoreStrand(input: RestoreStrandInput): boolean {
  const recorded = input.recordedCategory !== null || input.ghostAtBlock;
  const homeChanged =
    input.ghostAtBlock || input.homeCategory === undefined || input.homeCategory !== input.recordedCategory;
  return (
    recorded &&
    homeChanged &&
    input.landingCategory !== undefined &&
    input.landingCategory !== CATEGORY.IN_REVIEW &&
    (input.liveRound || input.postRecordVerdict)
  );
}
