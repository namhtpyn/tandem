// REVIEW LAW (final spec v2, 2026-10-29): reviews happen ON the task — never a
// subtask. task_reviews is the single source of truth for per-reviewer verdicts:
//   pending -> approved | rejected | change_requested   (+ escalated | superseded, non-votes)
//   end-of-round matrix (round settles only after the LAST verdict):
//     all approved            -> task done
//     all rejected            -> task cancelled (AI-only rounds included)
//     any request_change/split-> task back to assignee (ready), notes ride the next brief
// Sequential turns: ONE AI review turn in flight per task — a verdict's settle path
// lazy-mints the next pending reviewer's run (Redis holds nothing between turns).
// Envelope (strict): approved/rejected/request_change settle; `escalate` is a referral
// that swaps the reviewer up-chain on the TASK roster and never settles.
// Parks (round cannot progress without a human) flip the task to BLOCKED; owner
// resolution unblocks and the round resumes. Manual done/cancel supersedes the round.
import { consola } from 'consola';
import { and, desc, eq, gte, inArray, isNull, lt, ne, notInArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { asDb, db, type DbExecutor } from '../../db/index';
import {
  tasks,
  taskReviews,
  taskRuns,
  taskMessages,
  taskObligations,
  taskStatuses,
  aiEmployees,
  user,
} from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import {
  spawnObligation,
  spawnObligationTracked,
  cancelObligations,
  cancelAllObligations,
  cancelObligationById,
  deleteObligationById,
  resolveObligation,
  hasPendingAnswerHolder,
  cancelOrphanAnswerObligations,
} from './obligations.service';
import { dispatchTask, type DispatchOpts } from './runner.service';
import { insertActivityMessage } from './thread.service';

export type ReviewVerdict = Exclude<ReviewStatus, typeof REVIEW_STATUS.PENDING>;

import {
  CATEGORY,
  CHANGE_RESOURCE,
  CHANGE_ACTION,
  OBLIGATION_ROLE,
  OBLIGATION_STATUS,
  REVIEW_STATUS,
  ACTIVITY_KIND,
  type ActivityKind,
  type ReviewStatus,
  RUN_STATUS,
} from '#shared/enums';
import { STATUS } from '#shared/status';
import { nonNull } from '#shared/utils/non-null';

const log = consola.withTag('tandem');

const TODO_STATUS = STATUS.todo;

const DONE_STATUS = STATUS.done;
const CANCELLED_STATUS = STATUS.cancelled;
const BLOCKED_STATUS = STATUS.blocked;
const IN_REVIEW_STATUS = STATUS.inReview;

/** The status row's CATEGORY — lifecycle gates read the category, never the
 * seeded uuid (STATUS FREEDOM + CATEGORY-GATE LAW, SPEC #336): a custom status in
 * a category behaves exactly like its seeded sibling. A dangling status id (no
 * row) resolves to null: every allow-list gate refuses it (dead input); the
 * verdict path's terminal DENY-list lets it through so a legitimate settle can
 * heal the row instead of stranding the round. */
async function categoryOf(statusId: string): Promise<string | null> {
  const statuses = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
  return statuses.find((s) => s.id === statusId)?.category ?? null;
}

export async function logActivity(
  taskId: string,
  kind: ActivityKind,
  authorId: string | null,
  body: string,
  meta: Record<string, unknown>,
  ex: DbExecutor = db,
  opts: { thread?: boolean } = {},
) {
  // the thread IS the activity store (task_activity retired 2026-10-30); the
  // conversation row carries the same item (payload keeps the kind).
  // AI verdicts SKIP the thread copy (owner ruling 2026-10-29): the reviewer's run
  // bubble already carries the verdict — one response per turn.
  if (opts.thread !== false) await insertActivityMessage({ taskId, authorId, body, payload: { kind, ...meta } }, ex);
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

/** current (max) round for a task; 0 when never reviewed. `ex` keeps a caller's
 *  transaction (#397: the abandon teardown reads the round it is tearing down). */
export async function currentRound(taskId: string, ex: DbExecutor = db) {
  const rows = await asDb(ex)
    .select({ round: taskReviews.round })
    .from(taskReviews)
    .where(eq(taskReviews.taskId, taskId))
    .orderBy(desc(taskReviews.round))
    .limit(1);
  return rows[0]?.round ?? 0;
}

/** stable first-occurrence reviewer dedupe — duplicated ids must not mint two
 * review rows for the same round (the round unique index backstops this) */
export function dedupeReviewers(reviewers: string[]): string[] {
  return [...new Set(reviewers)];
}

/** a STORED roster value cannot be shape-rejected like wire input: Postgres accepts
 * braced and hyphenless uuid spellings, so a value that names a real employee must
 * survive whatever spelling a pre-canonical row carries (ID-SHAPE applies to the
 * wire, not the store). Returns the canonical 8-4-4-4-12 lowercase form, or null
 * when the value cannot name a uuid at all. */
export function canonicalStoredUuid(value: string): string | null {
  const hex = value
    .trim()
    .replace(/^\{|\}$/g, '')
    .replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const l = hex.toLowerCase();
  return `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`;
}

/** what an open round reports back: whether its in-review flip committed (a lost flip
 *  mints NOTHING), the round it minted, and the survivors/dropped reviewers */
export type OpenedRound = { flipped: boolean; round: number; opened: number; dropped: string[] };

/** the reviewers that still name an existing user — tasks.reviewers is a text[]
 * with NO FK, so a deleted employee's id can sit on the task and would hit
 * task_reviews.reviewer_id's FK (23503) at round open, wedging the submit with a
 * driver 500. Also ID-SHAPE + UUID-CASE (both laws): a legacy roster can carry a
 * value that never was a uuid (binding it to the uuid column raises 22P02 — the
 * same wedge one step earlier) and case variants of ONE id must collapse before
 * the round's unique index sees them. Returns canonical distinct survivors in
 * roster order (#361). */
export async function liveReviewers(reviewers: string[]): Promise<string[]> {
  const shaped = [...new Set(reviewers.map((id) => canonicalStoredUuid(id)).filter((id): id is string => id !== null))];
  if (shaped.length === 0) return [];
  const rows = await db.query.user.findMany({
    columns: { id: true },
    where: { id: { in: shaped } },
    orderBy: { id: 'asc' },
  });
  const present = new Set(rows.map((r) => r.id));
  return shaped.filter((id) => present.has(id));
}

/** the round an AI reviewer's LATEST run on the task was dispatched for: the newest
 * round whose review row already existed when that run started. Reading the
 * dispatched round at settle — instead of currentRound — is what keeps a stale run
 * from settling a newer round it was never part of. Exported for the verdict-less
 * bound (#276): the re-dispatch decision must bind to the SAME round as the verdict;
 * `at` pins the SETTLING run's start (a late-completing run must not bind to a
 * newer round via the latest-run lookup — #276 blind-review r4). */
export async function dispatchedReviewRoundRow(
  taskId: string,
  reviewerId: string,
  at?: Date,
): Promise<{ round: number; createdAt: Date } | null> {
  let startedAt = at ?? null;
  if (!startedAt) {
    const runRows = await db
      .select({ startedAt: taskRuns.startedAt })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
      .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.employeeId, reviewerId)))
      .orderBy(desc(taskRuns.startedAt))
      .limit(1);
    startedAt = runRows[0]?.startedAt ?? null;
  }
  if (!startedAt) return null;
  const rows = await db
    .select({ round: taskReviews.round, createdAt: taskReviews.createdAt })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.reviewerId, reviewerId)))
    .orderBy(desc(taskReviews.round));
  // rounds are minted in order; the dispatched round is the newest one open at run start
  return rows.find((r) => r.createdAt.getTime() <= startedAt.getTime()) ?? null;
}

/** the round NUMBER of the reviewer's dispatched round (0 = none) — see the row helper */
export async function dispatchedReviewRound(taskId: string, reviewerId: string, at?: Date) {
  return (await dispatchedReviewRoundRow(taskId, reviewerId, at))?.round ?? 0;
}

/** open a fresh review round: one pending row per reviewer + inbox obligations.
 * Called by submitResult. The task parks in-review; AI reviewers get review turns.
 *
 * REVIEWER-EXISTENCE TRANSACTION (#364): the caller's existence pre-check and these
 * inserts used to be separate statements, so an employee deleted BETWEEN them still
 * hit task_reviews.reviewer_id / task_obligations.employee_id with 23503 and failed
 * that submit. The survivor user rows are now locked FOR KEY SHARE in the SAME
 * transaction that inserts the round: a concurrent DELETE either committed before the
 * lock (the row is absent — the reviewer drops out of the round exactly like the
 * pre-check path) or blocks until this round commits, after which its FK nulls
 * reviewer_id and the row is a #365 non-vote. The ROUND OPEN can no longer raise
 * 23503 on the REVIEWER FK. A delete landing after the commit is that non-vote; one
 * racing the review turn's own dispatch mint (task_messages.author_id /
 * task_runs.employee_id) still fails that one turn — the round is already committed and
 * parks rearmable, never a wedge. (The task row itself is
 * a separate FK: a task deleted under the round open refuses that submit and the task
 * is gone — pre-existing, unchanged here.)
 * `opened: 0` (every reviewer vanished inside the window) is the caller's
 * zero-survivor outcome — nothing was minted, so nothing is left to settle. */
export async function openReviewRound(
  taskId: string,
  reviewers: string[],
  resultBody: string,
  flip: { status: string; updatedAt: Date },
): Promise<OpenedRound> {
  const uniqueReviewers = dedupeReviewers(reviewers);
  const now = new Date();
  // ROUND + FLIP ARE ONE TRANSACTION (#394): the in-review flip is the tx's FIRST write,
  // so a submit that LOSES the terminal arbitration writes NOTHING — no review rows, no
  // obligations, no round number. Only a won flip allocates a round, so two concurrent
  // submits cannot both mint rows (the loser's CAS misses on the very status+updatedAt it
  // read): no teardown can ever touch a concurrent winner's round, no round pointer can
  // advance past a round that never opened, and a losing submit can never leave a review
  // turn in flight against rows it does not own. The reviewer-existence KEY SHARE lock
  // rides the same tx (#364). Post-commit side effects (the round note, the reviewer
  // turn) are fault-isolated: the flip + rows are already the outcome, so a landed submit
  // must never be turned into a caller-visible error.
  const result = await db.transaction(async (tx) => {
    const d = asDb(tx);
    const locked =
      uniqueReviewers.length > 0
        ? await d.select({ id: user.id }).from(user).where(inArray(user.id, uniqueReviewers)).for('key share')
        : [];
    const live = new Set(locked.map((r) => r.id));
    const opened = uniqueReviewers.filter((reviewerId) => live.has(reviewerId));
    const dropped = uniqueReviewers.filter((reviewerId) => !live.has(reviewerId));
    // every reviewer vanished inside the lock window: no round, no flip — the caller
    // completes the task exactly as if none were set (#364)
    if (opened.length === 0) return { flipped: false, round: 0, opened: 0, dropped };
    const roundRows = await d
      .select({ round: taskReviews.round })
      .from(taskReviews)
      .where(eq(taskReviews.taskId, taskId))
      .orderBy(desc(taskReviews.round))
      .limit(1);
    const round = (roundRows[0]?.round ?? 0) + 1;
    // TERMINAL ARBITRATION (#292 r1/r2): the flip arbitrates on the status AND the
    // updatedAt stamp this submit read. 0 rows = a concurrent abandon/settle/submit owns
    // the outcome; this call returns flipped:false having written nothing.
    const flipped = await d
      .update(tasks)
      .set({ status: IN_REVIEW_STATUS, updatedAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, flip.status), eq(tasks.updatedAt, flip.updatedAt)))
      .returning({ id: tasks.id });
    if (flipped.length === 0) return { flipped: false, round, opened: opened.length, dropped };
    for (const reviewerId of opened) {
      await d.insert(taskReviews).values({
        id: uuidv7(),
        taskId,
        reviewerId,
        round,
        status: REVIEW_STATUS.PENDING,
        resultBody,
        createdAt: now,
      });
      // only a row THIS call created may be cancelled on rollback — spawnObligation is
      // idempotent per (task, employee, role) with no round column, so an older live
      // round's pending obligation would otherwise be cancelled by mistake (#361 r5);
      // the tx rollback owns every failure before this commit
      await spawnObligationTracked(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, now, tx);
    }
    return { flipped: true, round, opened: opened.length, dropped };
  });
  if (!result.flipped) return result;
  try {
    await logActivity(
      taskId,
      ACTIVITY_KIND.STATUS,
      null,
      `review round ${result.round} opened — waiting on ${result.opened} reviewer(s)`,
      { reviewRound: result.round },
    );
  } catch (e) {
    log.warn(
      `round ${result.round} opened but the note failed for task ${taskId}:`,
      e instanceof Error ? e.message : e,
    );
  }
  // the reviewer turn is the CALLER's post-flip step, not part of the open: the submit
  // still has to re-gate the task's parents, and a park raised here would be undone by
  // the parent-gating restore in that same window (a fresh rearmable park reads as a
  // blocked round with no open children). Dispatch therefore runs after the gating write,
  // for a WON flip only.
  return result;
}

/** close EVERY round that still shows a pending row — the zero-survivor completion
 *  path must not trust the MAX round: a superseded max round (failed round-open, lost
 *  duplicate submit) can hide an older round that is still live, and a done task must
 *  never keep a pending row or approval obligation (#361 r6). Task-wide cancel is
 *  correct here — the task is settling to done. */
export async function teardownAllPendingRounds(taskId: string, settledTo: string) {
  const pending = await db
    .select({ round: taskReviews.round })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.status, REVIEW_STATUS.PENDING)));
  if (pending.length === 0) return;
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.status, REVIEW_STATUS.PENDING)));
  await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  await logActivity(taskId, ACTIVITY_KIND.STATUS, null, 'review rounds closed — task settled', {
    roundClosed: true,
    settledTo,
  });
}

/** is the current round still LIVE (pending reviewers)? Rounds never close early —
 * a request_change keeps the round open until the last verdict lands — so LIVE means
 * pending rows exist. Drives where an answered question returns: a live review round
 * goes back to in-review, everything else back to todo. A PENDING row whose reviewer
 * no longer exists (employee deleted mid-round) is a non-vote — never live (#365). */
export async function openRoundLive(taskId: string) {
  const round = await currentRound(taskId);
  if (round === 0) return false;
  const rows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  return rows.some((r) => r.status === REVIEW_STATUS.PENDING && r.reviewerId !== null);
}

/** ANY pending row in the CURRENT round — a live reviewer's or a deleted reviewer's
 * void row. A waiting-answer task that still owns such a round belongs back in
 * in-review: the live one resumes on its reviewer turn, the extinguished one settles
 * by the normal matrix (#369). */
async function currentRoundHasPendingRow(taskId: string) {
  const round = await currentRound(taskId);
  if (round === 0) return false;
  const rows = await db
    .select({ id: taskReviews.id })
    .from(taskReviews)
    .where(
      and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.status, REVIEW_STATUS.PENDING)),
    )
    .limit(1);
  return rows.length > 0;
}

/** a PENDING row whose reviewer was deleted after the round minted it (the FK nulls
 * reviewer_id) can never carry a verdict — a NON-VOTE by construction (#365). The
 * machine signature of a removed reviewer: no legal write path produces it. */
function voidPending(r: { status: string; reviewerId: string | null }) {
  return r.status === REVIEW_STATUS.PENDING && r.reviewerId === null;
}

/** supersede a round's void pending rows (reviewers deleted mid-round) — audit
 * non-votes. Guarded on reviewer_id IS NULL so a live reviewer's pending row can
 * never be touched, and scoped to the round the caller read. */
async function extinguishVoidPendingRows(taskId: string, round: number) {
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
    .where(
      and(
        eq(taskReviews.taskId, taskId),
        eq(taskReviews.round, round),
        eq(taskReviews.status, REVIEW_STATUS.PENDING),
        isNull(taskReviews.reviewerId),
      ),
    );
}

/** supersede EVERY pending row in EVERY round — a terminal settle closes the whole
 *  task (#361 r6): a done/cancelled task must never keep a pending review row. */
async function supersedeAllPendingRows(taskId: string) {
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.status, REVIEW_STATUS.PENDING)));
}

const TERMINAL_CATEGORIES = new Set<string>([CATEGORY.DONE, CATEGORY.CANCELLED]);

/** TERMINAL RESIDUE (#365 r5): the settle's flip is its FIRST write, so a crash or a
 *  throwing teardown after the flip leaves a settled task still carrying the void row
 *  (and its siblings' pending approvals) — and nothing else would ever clear a
 *  CURRENT-round row. A settled task must never keep a pending review row or a
 *  pending approval obligation (#361 r6). Idempotent: on a clean task both writes are
 *  no-ops. Returns true when the task is terminal (the caller must not settle it). */
async function healTerminalResidue(taskId: string, statusId: string): Promise<boolean> {
  if (!TERMINAL_CATEGORIES.has((await categoryOf(statusId)) ?? '')) return false;
  // same trigger-last ordering as the settle: the row sweep erases the signature the
  // scans key on, so a failure before it must leave the row for the next trigger
  await cancelObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  await supersedeAllPendingRows(taskId);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return true;
}

/** an owner REOPEN (done/cancelled -> in-review) voids the machine signature: a void
 *  row left by a settle that flipped then died would otherwise let a later boot or
 *  unrelated-removal heal auto-settle the reopen the owner just made. Supersede every
 *  void pending row so the heals find nothing to settle (#365 r5). */
export async function discardVoidRows(taskId: string) {
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
    .where(
      and(
        eq(taskReviews.taskId, taskId),
        eq(taskReviews.status, REVIEW_STATUS.PENDING),
        isNull(taskReviews.reviewerId),
      ),
    );
}

/** settle a round left with NO live voter because its reviewer was deleted (#365):
 *  the normal matrix runs without the verdict that can never arrive — every decided
 *  row approved -> done, every decided row rejected -> cancelled, otherwise back to
 *  the assignee. The discriminator is the void pending row itself: only an employee
 *  delete can produce reviewer_id NULL on a pending row, so a legal manual re-queue
 *  to in-review over an already-decided round (no pending rows at all) is never
 *  stomped. The flip pins the status this call read, so any concurrent settle/move
 *  wins and this call reports false. */
export async function settleExtinguishedRound(taskId: string): Promise<boolean> {
  const taskRow = (
    await db.select({ status: tasks.status, updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, taskId))
  )[0];
  if (!taskRow) return false;
  if (await healTerminalResidue(taskId, taskRow.status)) return false;
  if ((await categoryOf(taskRow.status)) !== CATEGORY.IN_REVIEW) return false;
  const round = await currentRound(taskId);
  if (round === 0) return false;
  const rows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  if (!rows.some(voidPending)) return false; // machine signature only — never a manual state
  if (rows.some((r) => r.status === REVIEW_STATUS.PENDING && r.reviewerId !== null)) return false; // a live voter owns the round
  const live = rows.filter(
    (r) => r.status !== REVIEW_STATUS.ESCALATED && r.status !== REVIEW_STATUS.SUPERSEDED && !voidPending(r),
  );
  const allApproved = live.length > 0 && live.every((r) => r.status === REVIEW_STATUS.APPROVED);
  const allRejected = live.length > 0 && live.every((r) => r.status === REVIEW_STATUS.REJECTED);
  const target = allApproved ? DONE_STATUS : allRejected ? CANCELLED_STATUS : TODO_STATUS;
  // FLIP FIRST (#365 r3): the void pending row is the trigger every later heal keys on,
  // so it is extinguished only AFTER the flip wins — a lost CAS must leave the machine
  // signature intact for the next trigger, never strand an in-review round nothing can
  // ever settle again.
  const flipped = await db
    .update(tasks)
    // PARK-REARM LAW (#365 r6): the flip leaves BLOCKED, so the ladder is inert —
    // a settled round must never hand a spent ladder to the task's next park
    .set({ status: target, updatedAt: new Date(), parkRearmAttempts: 0, parkRearmAfter: null })
    // TERMINAL ARBITRATION (#292 r2): pin the status AND the updatedAt stamp this
    // call read — a manual round-trip back into the same in-review status (or a
    // submit re-flip) must beat a stale settle, never be stomped by it
    .where(and(eq(tasks.id, taskId), eq(tasks.status, taskRow.status), eq(tasks.updatedAt, taskRow.updatedAt)))
    .returning({ id: tasks.id });
  if (flipped.length === 0) return false; // a concurrent settle/move owns the outcome
  // TRIGGER LAST (#365 r6): the void row is the ONLY thing the boot/removal scans key
  // on, so every write that can fail runs BEFORE it is erased — a crash mid-teardown
  // leaves the signature intact and the next trigger retries the whole settle.
  // matrix parity: an approved round keeps its FULFILLED approvals (audit + approver
  // tally), a cancelled/returned round is dead for approval purposes
  if (allApproved) await cancelObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  else await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  if (allApproved || allRejected) await supersedeAllPendingRows(taskId); // #361 r6: no pending row outlives a terminal task
  await extinguishVoidPendingRows(taskId, round);
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    null,
    allApproved
      ? 'review round closed — every remaining reviewer approved'
      : allRejected
        ? 'review round closed — every remaining reviewer rejected'
        : 'review round closed — no reviewers remain; task returned to the assignee',
    { roundClosed: true, round, reviewersRemoved: true },
  );
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  if (target !== TODO_STATUS) {
    // a TERMINAL settle flips the task's status: re-gate its parents (every other
    // lifecycle flip does — an auto-blocked parent must unblock when its last child
    // lands terminal). Dynamic import keeps the module graph acyclic at load time.
    try {
      const { refreshParentGating } = await import('./gating.service');
      await refreshParentGating(taskId);
    } catch (e) {
      log.warn(`settle: parent re-gate failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  return true;
}

/** EMPLOYEE REMOVAL, run-capture half (#370): the departing employee's RUNNING REVIEW
 *  turns. A review turn is a live run on a task that is CURRENTLY in an in_review-
 *  category status AND carries a PENDING review row naming that reviewer — the work-run
 *  shape (working category) never matches, so a WORK run is left to settle normally and
 *  its bounce arm still returns an assignee-less doing task to todo. Read BEFORE the
 *  user delete; read-only. */
export async function runningReviewRunIdsForEmployee(employeeId: string): Promise<string[]> {
  const rows = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .innerJoin(tasks, eq(tasks.id, taskMessages.taskId))
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.status))
    .innerJoin(
      taskReviews,
      and(
        eq(taskReviews.taskId, taskMessages.taskId),
        eq(taskReviews.reviewerId, taskRuns.employeeId),
        eq(taskReviews.status, REVIEW_STATUS.PENDING),
      ),
    )
    .where(
      and(
        eq(taskRuns.employeeId, employeeId),
        eq(taskRuns.status, RUN_STATUS.RUNNING),
        eq(taskStatuses.category, CATEGORY.IN_REVIEW),
      ),
    )
    .limit(50);
  return [...new Set(rows.map((r) => r.id))];
}

/** BOOT BACKSTOP for the removal crash window (#370): a removal that died between the
 *  user delete and its stop arm leaves the departing reviewer's run RUNNING with a NULL
 *  employee_id — no live execution owns it, and the reaper would park the round after
 *  the timeout. Settle exactly those rows STOPPED (same CAS/marker semantics as the
 *  removal stop) so the resume arm can mint the next reviewer. Scoped to a task the
 *  void-row scan already flagged; `employee_id IS NULL` is machine-only. */
async function stopOrphanRemovalRuns(taskId: string) {
  const rows = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .innerJoin(tasks, eq(tasks.id, taskMessages.taskId))
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.status))
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskRuns.status, RUN_STATUS.RUNNING),
        isNull(taskRuns.employeeId),
        // REVIEW turns only: a working-category run left by a deleted assignee keeps
        // its normal bounce (stopping it would strand an assignee-less doing task)
        eq(taskStatuses.category, CATEGORY.IN_REVIEW),
      ),
    )
    .limit(50);
  if (rows.length === 0) return;
  const { stopRunsForRemoval } = await import('./runner.service');
  await stopRunsForRemoval(rows.map((r) => r.id));
}

/** REVIEWER REMOVAL, prepare half (#365): a READ-ONLY capture taken BEFORE the
 * employee's user row is deleted — the pending review rows they hold, their pending
 * APPROVAL obligations, and (ANSWER-ROLE REMOVAL, #369) their pending ANSWER
 * obligations. Nothing is mutated here: a failed delete must change nothing, so every
 * write happens in settleReviewerRemovalRounds after it lands. */
export type ReviewerRemovalPlan = {
  taskIds: string[];
  reviewRowIds: string[];
  obligationIds: string[];
  /** PENDING ANSWER obligations held by the departing employee (#369) */
  answerObligations: Array<{ id: string; taskId: string }>;
};

export async function prepareReviewerRemoval(employeeId: string): Promise<ReviewerRemovalPlan> {
  const pending = await db
    .select({ id: taskReviews.id, taskId: taskReviews.taskId })
    .from(taskReviews)
    .where(and(eq(taskReviews.reviewerId, employeeId), eq(taskReviews.status, REVIEW_STATUS.PENDING)))
    .limit(100);
  const obligations = await db
    .select({ id: taskObligations.id })
    .from(taskObligations)
    .where(
      and(
        eq(taskObligations.employeeId, employeeId),
        eq(taskObligations.role, OBLIGATION_ROLE.APPROVAL),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    );
  const answerObligations = await db
    .select({ id: taskObligations.id, taskId: taskObligations.taskId })
    .from(taskObligations)
    .where(
      and(
        eq(taskObligations.employeeId, employeeId),
        eq(taskObligations.role, OBLIGATION_ROLE.ANSWER),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
      ),
    );
  return {
    taskIds: [...new Set(pending.map((p) => p.taskId))],
    reviewRowIds: pending.map((p) => p.id),
    obligationIds: obligations.map((o) => o.id),
    answerObligations,
  };
}

/** ANSWER-ROLE REMOVAL, return half (#369): the departing holder's PENDING ANSWER
 *  obligations are already cancelled by id (the delete nulls employee_id, so the id
 *  captured before it is the only stable handle). A task left in a waiting_answer
 *  category with NO pending holder can never move again — nothing can answer, forward
 *  or abandon it — so it returns to its flow instead of stranding: a round with any
 *  pending row lands back in-review (a live reviewer re-fires, an extinguished one
 *  settles by the matrix), anything else returns to todo with a cleared question chain
 *  and re-gates its parents. The flip pins the status AND updatedAt it read: a
 *  concurrent settle/move owns the outcome and this call touches nothing. Idempotent —
 *  a second pass finds no waiting task. */
export async function returnRemovedAnswerHolderTask(taskId: string, name?: string): Promise<boolean> {
  const taskRow = (
    await db
      .select({
        status: tasks.status,
        updatedAt: tasks.updatedAt,
        preBlockStatus: tasks.preBlockStatus,
        parkFromStatus: tasks.parkFromStatus,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
  )[0];
  if (!taskRow) return false;
  const category = await categoryOf(taskRow.status);
  // A BLOCKED task is SUSPENDED, not settled: its pre-block/park origin may be a
  // waiting-answer status and the gating restore resumes the question — the #365 rule
  // (a blocked/parked task must keep its machine signature or its unblock can never
  // settle) applies to the ANSWER row too. Never cancel it here; the unblocked task's
  // next sweep returns it (the probe's orphan arm covers the gap).
  if (taskRow.status === BLOCKED_STATUS) return false;
  // only a waiting-answer task owns the flow this arm repairs — a stale obligation on
  // any other status is cleared by the NULL-holder sweep (never a task-wide cancel:
  // the ask/forward paths spawn-then-flip and a cancel inside that window bags the spawn)
  if (category !== CATEGORY.WAITING_ANSWER) {
    await healLeftWaitingAnswer(taskId, category, taskRow.updatedAt);
    return false;
  }
  // ANY pending row still naming a live holder keeps the question alive — the
  // newest-row projection would let a newer NULL-holder orphan mask an older holder
  if (await hasPendingAnswerHolder(taskId)) {
    // the dead row must not keep masking the live holder in answerHolder()
    await cancelOrphanAnswerObligations(taskId);
    return false;
  }
  // A round with ANY pending row (live or extinguished) belongs back in in-review: a
  // live round resumes on its reviewer turn, an extinguished one (a deleted reviewer's
  // void row) settles by the normal matrix — never straight to todo, or the matrix
  // (all-approved -> done) would be unreachable forever.
  const backTo = (await currentRoundHasPendingRow(taskId)) ? IN_REVIEW_STATUS : TODO_STATUS;
  const flipped = await db
    .update(tasks)
    .set({ status: backTo, questionChain: [], updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, taskRow.status), eq(tasks.updatedAt, taskRow.updatedAt)))
    .returning({ id: tasks.id });
  if (flipped.length === 0) return false; // a concurrent answer/settle/move owns the outcome
  await finishRemovedHolderReturn(taskId, backTo, name);
  return true;
}

/** the answer arm's non-waiting half (#369): an IN-REVIEW landing may owe the reviewer
 *  mint a crash between the return flip and its re-fire (the broader lazy-mint gap is
 *  #371) — re-fire FIRST, then clear only the dead rows older than the task write the
 *  caller read. Trigger-last: a crash between the two leaves the NULL-holder row for
 *  the next sweep, and the `before` cut leaves a mid-flight ask/forward spawn (its row
 *  is newer than the task write) untouched — its own flip lands and the waiting-answer
 *  arm heals it. */
async function healLeftWaitingAnswer(taskId: string, category: string | null, taskUpdatedAt: Date) {
  if (category === CATEGORY.IN_REVIEW) {
    try {
      await dispatchAiReviewTurns(taskId);
    } catch (e) {
      log.warn(
        `answer holder removal: could not re-fire the review turn for ${taskId}:`,
        e instanceof Error ? e.message : e,
      );
      // a live round with a pending reviewer and no run must not wedge silently —
      // park (rearmable) and KEEP the NULL-holder signature for the next sweep
      try {
        await parkRound(taskId, 'reviewer re-fire failed while healing an answer-holder removal', { rearmable: true });
      } catch (e2) {
        log.warn(`answer holder removal: could not park ${taskId}:`, e2 instanceof Error ? e2.message : e2);
      }
      return;
    }
    // an extinguished round (a void pending row with no live voter) settles by the
    // normal matrix — the same crash state finishRemovedHolderReturn closes
    try {
      await settleExtinguishedRound(taskId);
    } catch (e) {
      log.warn(`answer holder removal: could not settle the round for ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  await cancelOrphanAnswerObligations(taskId, taskUpdatedAt);
}

/** does the task carry the #369 machine signature — a PENDING ANSWER row whose holder
 *  no longer exists (FK set-null)? The ONLY state any return arm may act on: a legal
 *  manual move into a waiting-answer status carries no pending row and is never
 *  stomped (the same discriminator the boot/removal sweeps key on). */
export async function hasOrphanAnswerSignature(taskId: string) {
  const rows = await db
    .select({ id: taskObligations.id })
    .from(taskObligations)
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.role, OBLIGATION_ROLE.ANSWER),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
        isNull(taskObligations.employeeId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** the answer arm's post-flip half (#369): one thread note, then the re-fire /
 *  matrix / parent re-gate, and the scoped teardown LAST. Every step is fault-isolated
 *  — the flip already landed, so a failure here must never skip the remaining ones or
 *  500 the caller. */
async function finishRemovedHolderReturn(taskId: string, backTo: string, name?: string) {
  try {
    await logActivity(
      taskId,
      ACTIVITY_KIND.NOTE,
      null,
      backTo === IN_REVIEW_STATUS
        ? `answer holder removed${name ? ` (${name})` : ''} — the review round resumes`
        : `answer holder removed${name ? ` (${name})` : ''} — the task returned to the assignee`,
      { answerHolderRemoved: true, returnedTo: backTo },
    );
  } catch (e) {
    log.warn(`answer holder removal: could not note the return for ${taskId}:`, e instanceof Error ? e.message : e);
  }
  if (backTo === IN_REVIEW_STATUS) {
    try {
      await dispatchAiReviewTurns(taskId);
    } catch (e) {
      log.warn(
        `answer holder removal: could not re-fire the review turn for ${taskId}:`,
        e instanceof Error ? e.message : e,
      );
      // a live round with a pending reviewer and no run must not wedge silently —
      // park (rearmable) so the existing ladder owns the recovery
      try {
        await parkRound(taskId, 'reviewer re-fire failed after answer-holder removal', { rearmable: true });
      } catch (e2) {
        log.warn(`answer holder removal: could not park ${taskId}:`, e2 instanceof Error ? e2.message : e2);
      }
    }
    // an EXTINGUISHED round (a deleted reviewer's void row) settles by the normal
    // matrix now that the task is back in in-review; a live round is a no-op here
    try {
      await settleExtinguishedRound(taskId);
    } catch (e) {
      log.warn(`answer holder removal: could not settle the round for ${taskId}:`, e instanceof Error ? e.message : e);
    }
  } else {
    try {
      const { refreshParentGating } = await import('./gating.service');
      await refreshParentGating(taskId);
    } catch (e) {
      log.warn(`answer holder removal: could not re-gate parents of ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  // TEARDOWN LAST (#369 r3): the NULL-holder row is the machine signature every
  // heal keys on — cancelling it before the re-fire/matrix/re-gate landed would let a
  // process death in that window strand the task with nothing left to find. Only a
  // WON flip reaches here (#314), and the sweep clears it on a later pass if this last
  // write dies. SCOPED (#369 r2): never a task-wide cancel — a concurrent ask/forward
  // spawns a live-holder row (spawn-then-flip) and a task-wide cancel would erase it,
  // stranding the ask with no obligation. The departing holder's rows are cancelled by
  // id by the caller.
  try {
    await cancelOrphanAnswerObligations(taskId);
  } catch (e) {
    log.warn(
      `answer holder removal: could not cancel the orphan ANSWER rows ${taskId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** NEXT TURN (#371): a removal voids/decides the departing reviewer's row — if the
 *  task is still in an in_review-category status with a live PENDING reviewer, the
 *  sequential queue has NOTHING in flight (the mint only advances on a verdict that
 *  can never arrive from the removed reviewer). Re-mint the next AI turn. The task
 *  category and a live row gate it; dispatchAiReviewTurns itself skips humans and an
 *  already-running reviewer and issues at most ONE dispatch per call. The caller
 *  fault-isolates it — the delete already committed. */
export async function resumeReviewQueueAfterRemoval(taskId: string) {
  const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!row) return;
  if ((await categoryOf(row.status)) !== CATEGORY.IN_REVIEW) return;
  if (!(await openRoundLive(taskId))) return;
  await dispatchAiReviewTurns(taskId);
}

/** REVIEWER REMOVAL, settle half (#365): runs AFTER the user delete. Mutates only
 *  what the delete made stale: cancels the captured approval obligations by id,
 *  notes the captured rows (still PENDING and now void — a verdict that landed in
 *  the capture→delete window keeps its own note), then settles every affected round
 *  plus any leftover void row (the machine signature — catches a round minted inside
 *  the prepare→delete window and any removal that crashed mid-way). Every step is
 *  fault-isolated: the delete already committed, so a heal failure must never 500
 *  the caller or skip the employee-delete bookkeeping; the boot heal retries. */
export async function settleReviewerRemovalRounds(plan: ReviewerRemovalPlan, name?: string): Promise<string[]> {
  const settledTaskIds: string[] = [];
  for (const obligationId of plan.obligationIds) {
    try {
      await deleteObligationById(obligationId);
    } catch (e) {
      log.warn(`reviewer removal: could not drop obligation ${obligationId}:`, e instanceof Error ? e.message : e);
    }
  }
  // ANSWER-ROLE REMOVAL (#369): a holder removed mid-question leaves a PENDING
  // ANSWER obligation whose FK nulls employee_id — nothing can answer, forward or
  // abandon the task. Cancel exactly the captured rows by id, then return every
  // affected task that lost its only holder to its flow.
  // NOTE BEFORE THE ANSWER ARM (#369 r3): the answer arm may settle an extinguished
  // round and supersede the very void rows this note pins — write the note first so a
  // dual-role departing employee (answer holder + last pending reviewer) is named.
  if (plan.reviewRowIds.length > 0) {
    try {
      await db
        .update(taskReviews)
        .set({ note: `reviewer removed — ${name ?? 'employee deleted'}` })
        .where(
          and(
            inArray(taskReviews.id, plan.reviewRowIds),
            eq(taskReviews.status, REVIEW_STATUS.PENDING),
            isNull(taskReviews.reviewerId),
          ),
        );
    } catch (e) {
      log.warn('reviewer removal: could not note the removed reviewer rows:', e instanceof Error ? e.message : e);
    }
  }
  await settleAnswerHolderRemoval(plan.answerObligations, name, settledTaskIds);
  let leftover: Array<{ taskId: string }> = [];
  try {
    // bounded: a delete heals at most this many tasks synchronously; the rest drain
    // through the next boot heal (never an unbounded job inside one RPC)
    leftover = await db
      .select({ taskId: taskReviews.taskId })
      .from(taskReviews)
      .where(and(eq(taskReviews.status, REVIEW_STATUS.PENDING), isNull(taskReviews.reviewerId)))
      .limit(50);
  } catch (e) {
    log.warn('reviewer removal: void review row scan failed:', e instanceof Error ? e.message : e);
  }
  const taskIds = [...new Set([...plan.taskIds, ...leftover.map((r) => r.taskId)])];
  for (const taskId of taskIds) {
    try {
      if (await settleExtinguishedRound(taskId)) settledTaskIds.push(taskId);
      await cleanVoidReviewDebris(taskId);
    } catch (e) {
      log.warn(`reviewer removal: could not settle round for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    try {
      await resumeReviewQueueAfterRemoval(taskId);
    } catch (e) {
      log.warn(
        `reviewer removal: could not resume the review queue for task ${taskId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  // ANSWER-ROLE REMOVAL leftover (#369): the same crash-window sweep — an orphan
  // PENDING ANSWER obligation (NULL holder = only an employee delete produces it)
  // left by an earlier removal that died before its return arm.
  await sweepOrphanAnswerHolders(settledTaskIds);
  return settledTaskIds;
}

/** ANSWER-ROLE REMOVAL, mutation half (#369): cancel the departing holder's
 *  captured PENDING ANSWER obligations by id (their FK has already nulled, so the id
 *  is the only handle) and return every affected task that lost its only holder.
 *  Each step is fault-isolated — the delete already committed. */
async function settleAnswerHolderRemoval(
  answerObligations: ReviewerRemovalPlan['answerObligations'],
  name: string | undefined,
  settledTaskIds: string[],
) {
  const byTask = new Map<string, string[]>();
  for (const obligation of answerObligations) {
    byTask.set(obligation.taskId, [...(byTask.get(obligation.taskId) ?? []), obligation.id]);
  }
  for (const [taskId, obligationIds] of byTask) {
    // TRIGGER-LAST (#365 r6 / #314): the return arm runs FIRST — the departing row is
    // already NULL-holder by FK, and cancelling it before the flip would erase the only
    // machine signature a crash between the two writes leaves for the boot heal.
    let healed = false;
    try {
      healed = await returnRemovedAnswerHolderTask(taskId, name);
    } catch (e) {
      log.warn(`answer holder removal: could not return task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    if (healed) settledTaskIds.push(taskId);
    // The departing rows are dead either way — but when the task still WAITS on an
    // orphan (no live holder), keep them PENDING as the machine signature: the boot
    // heal and the next removal sweep re-run the return arm. Cancel only when the task
    // moved on or a live holder owns the question now — a FAILED re-read keeps the
    // signature (never erase it on an error).
    let keepSignature = true;
    try {
      keepSignature = await taskStillWaitsOnOrphan(taskId);
    } catch (e) {
      log.warn(`answer holder removal: could not re-read task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    if (keepSignature) continue;
    for (const obligationId of obligationIds) {
      try {
        await cancelObligationById(obligationId);
      } catch (e) {
        log.warn(
          `answer holder removal: could not cancel obligation ${obligationId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}

/** the task still sits in a waiting-answer category with NO live holder — the state
 *  whose only machine signature is the departed holder's NULL-holder PENDING row.
 *  A BLOCKED task counts as still-waiting: its pre_block/park origin may be the
 *  waiting-answer status the unblock restores (the #365 rule), so its rows are kept. */
async function taskStillWaitsOnOrphan(taskId: string): Promise<boolean> {
  const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!row) return false;
  if (row.status === BLOCKED_STATUS) return true;
  if ((await categoryOf(row.status)) !== CATEGORY.WAITING_ANSWER) return false;
  return !(await hasPendingAnswerHolder(taskId));
}

/** crash-window sweep for ANSWER orphans (#369): a PENDING ANSWER obligation with a
 *  NULL holder can only come from an employee delete — return its task to the flow
 *  (the removal that produced it either crashed before its return arm or predated it).
 *  Bounded; the rest drain on the next boot/removal. */
async function sweepOrphanAnswerHolders(settledTaskIds: string[]) {
  let leftoverAnswers: Array<{ taskId: string }> = [];
  try {
    leftoverAnswers = await db
      .select({ taskId: taskObligations.taskId })
      .from(taskObligations)
      .innerJoin(tasks, eq(tasks.id, taskObligations.taskId))
      .where(
        and(
          eq(taskObligations.role, OBLIGATION_ROLE.ANSWER),
          eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
          isNull(taskObligations.employeeId),
          // a BLOCKED task keeps its signature by contract (#369): never let those rows
          // occupy the scan window — oldest first so a real orphan is never starved
          ne(tasks.status, BLOCKED_STATUS),
        ),
      )
      .orderBy(taskObligations.createdAt)
      .limit(50);
  } catch (e) {
    log.warn('answer holder removal: orphan answer scan failed:', e instanceof Error ? e.message : e);
  }
  for (const taskId of new Set(leftoverAnswers.map((r) => r.taskId))) {
    try {
      if (await returnRemovedAnswerHolderTask(taskId)) settledTaskIds.push(taskId);
    } catch (e) {
      log.warn(`answer holder removal: could not return task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** void rows in NON-current rounds are audit debris (a round the matrix has moved
 *  past can never settle) — cleared for tasks the removal/heal touched. A CURRENT
 *  round's void row is NEVER cleared here, whatever the task's status: it is the
 *  machine signature every restore path keys on (a blocked/parked task must keep it
 *  or its unblock can never settle). A PENDING approval obligation whose holder is
 *  NULL belongs to a deleted employee — `pendingTaskIds()` still counts it and
 *  retention leg 2 refuses to delete the task's resolved rows while it lives — so
 *  the orphan row is dropped whole (marking it CANCELLED would read as "round dead"
 *  to approvalsInRoundBatch and blank the surviving approvers). */
async function cleanVoidReviewDebris(taskId: string) {
  const round = await currentRound(taskId);
  if (round > 0) {
    await db
      .update(taskReviews)
      .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
      .where(
        and(
          eq(taskReviews.taskId, taskId),
          eq(taskReviews.status, REVIEW_STATUS.PENDING),
          isNull(taskReviews.reviewerId),
          lt(taskReviews.round, round),
        ),
      );
  }
  await db
    .delete(taskObligations)
    .where(
      and(
        eq(taskObligations.taskId, taskId),
        eq(taskObligations.role, OBLIGATION_ROLE.APPROVAL),
        eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
        isNull(taskObligations.employeeId),
      ),
    );
}

/** STALLED-REVIEW SWEEP (#397): a round that COMMITTED but never dispatched a turn —
 *  the crash window between openReviewRound's transaction and the reviewer turn (#394
 *  moved the dispatch after the commit) — leaves an in-review task with a PENDING AI
 *  reviewer row, no run in flight and no park marker. Nothing scanned that shape: the
 *  liveness sweep covers working-category tasks, the park re-arm scan covers BLOCKED
 *  rows with a due ladder, and the boot heal keys on FK-voided rows. This tick arm
 *  re-fires the turn with the ordinary sequential mint (which re-checks liveness and
 *  parks a mint failure on the re-arm ladder).
 *
 *  Discriminators (no legal write path produces the shape):
 *  - the task sits in an in_review-category status (a manual move out of review legally
 *    leaves pending rows behind — those are not stalled rounds);
 *  - the row belongs to the CURRENT round and names a live AI reviewer (humans are
 *    card-driven and get no turn; a void row is the removal heal's signature);
 *  - no RUNNING run on the task (a live turn owns the round);
 *  - the reviewer was never dispatched in this round (no run started after the row was
 *    minted) — a reviewer that already had a turn belongs to the verdict-less
 *    correction / park machinery, never to this sweep;
 *  - the row is older than STALLED_REVIEW_GRACE_MS, so the legal in-flight window
 *    between the commit, the parent re-gate and the dispatch can never match.
 *  Bounded + best-effort like every other tick arm; at most one dispatch per task per
 *  tick (the sequential law owns the rest). */
export const STALLED_REVIEW_GRACE_MS = 60_000;
const STALLED_REVIEW_SCAN_LIMIT = 20;

export type StalledReviewCandidate = { taskId: string; round: number; reviewerId: string; createdAt: Date };

/** the sweep's bounded read: PENDING rows of a live AI reviewer on an in-review task,
 *  older than the grace cutoff, oldest first. The round/run discriminators are decided
 *  per row (stalledReviewRefire) because they need a second read. */
export function stalledReviewScan(ex: DbExecutor, cutoff: Date) {
  return asDb(ex)
    .select({
      taskId: taskReviews.taskId,
      round: taskReviews.round,
      reviewerId: taskReviews.reviewerId,
      createdAt: taskReviews.createdAt,
    })
    .from(taskReviews)
    .innerJoin(tasks, eq(tasks.id, taskReviews.taskId))
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.status))
    .innerJoin(aiEmployees, eq(aiEmployees.userId, taskReviews.reviewerId))
    .where(
      and(
        eq(taskStatuses.category, CATEGORY.IN_REVIEW),
        eq(taskReviews.status, REVIEW_STATUS.PENDING),
        lt(taskReviews.createdAt, cutoff),
      ),
    )
    .orderBy(taskReviews.createdAt)
    .limit(STALLED_REVIEW_SCAN_LIMIT);
}

/** pure decision for one candidate: is this the crash-window shape? */
export function stalledReviewRefire(
  candidate: StalledReviewCandidate,
  probe: { round: number; liveRun: boolean; reviewerRunSince: Date | null },
): boolean {
  if (probe.round !== candidate.round) return false; // a superseded round never re-fires
  if (probe.liveRun) return false; // a live turn owns the round
  if (probe.reviewerRunSince !== null) return false; // already dispatched this round
  return true;
}

/** is a run live on the task? (review turns never claim the task, so the run row is the
 *  only liveness signal) */
async function taskHasLiveRun(taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.status, RUN_STATUS.RUNNING)))
    .limit(1);
  return rows.length > 0;
}

/** the reviewer's newest run on the task started at/after `at` (the round's row), or
 *  null when this round never dispatched them */
async function reviewerRunAtOrAfter(taskId: string, reviewerId: string, at: Date): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: taskRuns.startedAt })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.employeeId, reviewerId), gte(taskRuns.startedAt, at)))
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  return rows[0]?.startedAt ?? null;
}

/** tick arm: re-fire rounds left with a pending AI reviewer and no turn in flight.
 *  Never rejects (a failed tick means try again next tick). Returns the count. */
export async function sweepStalledReviewTurns(): Promise<number> {
  try {
    return await sweepStalledReviewTurnsInner();
  } catch (e) {
    log.warn('stalled-review sweep failed:', e instanceof Error ? e.message : e);
    return 0;
  }
}

async function sweepStalledReviewTurnsInner(): Promise<number> {
  const candidates = await stalledReviewScan(db, new Date(Date.now() - STALLED_REVIEW_GRACE_MS));
  const seen = new Set<string>();
  let refired = 0;
  for (const candidate of candidates) {
    if (!candidate.reviewerId || seen.has(candidate.taskId)) continue;
    seen.add(candidate.taskId);
    try {
      const probe = {
        round: await currentRound(candidate.taskId),
        liveRun: await taskHasLiveRun(candidate.taskId),
        reviewerRunSince: null as Date | null,
      };
      if (!probe.liveRun) {
        probe.reviewerRunSince = await reviewerRunAtOrAfter(
          candidate.taskId,
          candidate.reviewerId,
          candidate.createdAt,
        );
      }
      if (!stalledReviewRefire({ ...candidate, reviewerId: candidate.reviewerId }, probe)) continue;
      // the ordinary sequential mint: it re-checks the live-run guard, dispatches ONE
      // AI turn and parks a mint failure on the re-arm ladder — the sweep adds no
      // second dispatch path and writes no outcome note of its own (the mint's own
      // note reports what actually happened).
      await dispatchAiReviewTurns(candidate.taskId);
      refired += 1;
      log.info(`stalled-review sweep: re-fired round ${candidate.round} on task ${candidate.taskId}`);
    } catch (e) {
      log.warn(`stalled-review sweep: could not re-fire task ${candidate.taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  return refired;
}

/** BOOT HEAL (#365): settle every in-review round left with a void pending row and
 *  no live voter — the shape a removal that crashed between the user delete and the
 *  settle leaves behind — and clear the void debris (stale-round rows, orphaned
 *  approval obligations) left by any earlier removal. Idempotent; the scan reads
 *  PENDING rows only (bounded — the rest drain on the next boot). Never throws (boot
 *  must not fail on a heal). Returns the settled task ids. */
export async function settleAllExtinguishedRounds(): Promise<string[]> {
  // FAULT ISOLATION (#369): the two heals are independent scans — a failing
  // task_reviews read must never disable the ANSWER-holder heal (or vice versa).
  let taskIds: string[] = [];
  try {
    const rows = await db
      .select({ taskId: taskReviews.taskId })
      .from(taskReviews)
      .where(and(eq(taskReviews.status, REVIEW_STATUS.PENDING), isNull(taskReviews.reviewerId)))
      .limit(200);
    taskIds = [...new Set(rows.map((r) => r.taskId))];
  } catch (e) {
    log.warn('void review row scan failed:', e instanceof Error ? e.message : e);
  }
  const settledTaskIds: string[] = [];
  for (const taskId of taskIds) {
    // NEXT-TURN CRASH BACKSTOP (#371), STOP FIRST: a removal that died between the
    // user delete and its stop arm leaves the departing reviewer's run RUNNING with the
    // FK-nulled employee_id. Settle it BEFORE the round matrix — once a sole-void round
    // settles, the task leaves the in_review category and the review-scoped orphan scan
    // could never match it again. Order mirrors the removal RPC (stop, then settle).
    try {
      await stopOrphanRemovalRuns(taskId);
    } catch (e) {
      log.warn(`void review round orphan stop failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    try {
      if (await settleExtinguishedRound(taskId)) settledTaskIds.push(taskId);
      await cleanVoidReviewDebris(taskId);
    } catch (e) {
      log.warn(`void review round heal failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    // …then re-mint a round still holding a live PENDING reviewer (a live-voter round
    // with a running turn is a no-op via dispatchAiReviewTurns' task-wide guard; a
    // settled task is gated out by category).
    try {
      await resumeReviewQueueAfterRemoval(taskId);
    } catch (e) {
      log.warn(`void review round resume failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  // ANSWER-ROLE REMOVAL (#369): the same crash-window heal for a waiting-answer
  // task whose only ANSWER obligation lost its holder (NULL employee_id is the
  // machine signature — no legal write path produces it). Bounded like the void-row
  // scan; the rest drain on the next boot.
  let answerTaskIds: string[] = [];
  try {
    const rows = await db
      .select({ taskId: taskObligations.taskId })
      .from(taskObligations)
      .innerJoin(tasks, eq(tasks.id, taskObligations.taskId))
      .where(
        and(
          eq(taskObligations.role, OBLIGATION_ROLE.ANSWER),
          eq(taskObligations.status, OBLIGATION_STATUS.PENDING),
          isNull(taskObligations.employeeId),
          // BLOCKED tasks keep their signature by contract (#369) — never scan them
          ne(tasks.status, BLOCKED_STATUS),
        ),
      )
      .orderBy(taskObligations.createdAt)
      .limit(200);
    answerTaskIds = [...new Set(rows.map((r) => r.taskId))];
  } catch (e) {
    log.warn('orphan answer obligation scan failed:', e instanceof Error ? e.message : e);
  }
  for (const taskId of answerTaskIds) {
    try {
      if (await returnRemovedAnswerHolderTask(taskId)) settledTaskIds.push(taskId);
    } catch (e) {
      log.warn(`answer holder heal failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  return settledTaskIds;
}

/** the submitted result the current round is judging — the round rows carry it
 * (set at openReviewRound; task_activity retired 2026-10-30) */
async function roundResultBody(taskId: string) {
  const round = await currentRound(taskId);
  if (round === 0) return '';
  const rows = await db
    .select({ resultBody: taskReviews.resultBody })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)))
    .limit(1);
  return rows[0]?.resultBody ?? '';
}

/** task ids whose review-mint decision is in flight in THIS process — the mint is a
 *  read-then-dispatch; two concurrent triggers on one task (concurrent removals, a
 *  removal racing a verdict settle) would both pass the reads and mint twice. The lock
 *  makes the decision+dispatch one critical section; a skipped caller is safe because
 *  the winner mints the next turn and the next verdict mints the one after. */
const reviewMintInFlight = new Set<string>();

/** fire the NEXT pending AI reviewer's turn — exactly one per call (sequential law:
 * one review turn in flight per task; the verdict's settle path lazy-mints the next).
 * Round order = row order. Human reviewers are skipped (the card is their UI).
 * Sessions are per (task, reviewer) — never the assignee's session.
 * opts.verdictCorrection (#276): rides ONLY the verdict-less settle path's bounded
 * re-dispatch — the retry brief carries the CORRECTION block. */
export async function dispatchAiReviewTurns(taskId: string, resultBody?: string, opts?: DispatchOpts) {
  if (reviewMintInFlight.has(taskId)) return;
  reviewMintInFlight.add(taskId);
  try {
    await dispatchAiReviewTurnsUnlocked(taskId, resultBody, opts);
  } finally {
    reviewMintInFlight.delete(taskId);
  }
}

async function dispatchAiReviewTurnsUnlocked(taskId: string, resultBody?: string, opts?: DispatchOpts) {
  const round = await currentRound(taskId);
  if (round === 0) return;
  // SEQUENTIAL, TASK-WIDE (#371): ONE review turn in flight per task. A mint requested
  // while ANY run of the task is RUNNING is a no-op — without this, a removal that
  // voids a third reviewer's row would skip the running reviewer and mint the NEXT
  // pending AI reviewer beside it (two turns in flight, one round). The settling run
  // is already DONE when its own settle path asks for the next turn (writer.finish's
  // guarded row write lands before settleDoneRun), so the chain is unaffected.
  const inFlight = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.status, RUN_STATUS.RUNNING)))
    .limit(1);
  if (inFlight.length > 0) return;
  const rows = await db
    .select()
    .from(taskReviews)
    .where(
      and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.status, REVIEW_STATUS.PENDING)),
    )
    .orderBy(taskReviews.createdAt);
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const aiIds = new Set(aiRows.map((r) => r.userId));
  const body = resultBody ?? (await roundResultBody(taskId));
  for (const row of rows) {
    if (!row.reviewerId || !aiIds.has(row.reviewerId)) continue; // human reviewer: the card is enough
    // VERDICT-LESS CORRECTION (#276, blind-review r5): a correction re-dispatch is
    // TARGET-scoped — only the verdict-less reviewer's own row is retried (row order
    // ties would otherwise hand the retry to a different first-turn reviewer and
    // drop the verdict-less one's retry entirely). Target row not pending anymore
    // (a human verdict landed mid-flight) -> nothing mints: the round moved on.
    if (opts?.verdictlessReviewerId && row.reviewerId !== opts.verdictlessReviewerId) continue;
    try {
      // target-scoped above: a correction dispatch can only ever reach the
      // verdict-less reviewer's own turn
      await dispatchTask(taskId, 'http://tandem.internal', {
        reviewBy: row.reviewerId,
        resultBody: body,
        verdictCorrection: opts?.verdictCorrection === true,
      });
      await logActivity(taskId, ACTIVITY_KIND.STATUS, null, `review turn dispatched to reviewer ${row.reviewerId}`, {
        reviewTurn: true,
        reviewerId: row.reviewerId,
        round,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await logActivity(taskId, ACTIVITY_KIND.STATUS, null, `review turn failed to dispatch: ${reason}`, {
        reviewTurnFailed: true,
        reviewerId: row.reviewerId,
        round,
      });
      // SETTLE-FAILURE PARK (SPEC, #199): a mint failure leaves the PENDING row with
      // nothing to re-fire it — park instead of stranding the round silently. Owner
      // unblock (status -> in-review) re-dispatches through the unblock-resume path.
      // REARMABLE (#211): a mint failure is infra-class — the re-arm ladder re-fires it.
      const parked = await parkRound(taskId, `review turn failed to dispatch — ${reason}`, { rearmable: true });
      if (!parked) {
        // ROUND-OPEN WINDOW (#282): the park only lands from in-review — a miss means
        // the task is elsewhere. Rethrow ONLY from the round-open window (the task
        // still sits in a working category, so the submit must fail and leave it
        // working); any other off-in-review state (owner move, settle) already won —
        // throwing there would only 500 a caller that did nothing wrong (#292 r1).
        const cur = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
        const cats = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
        const cat = cats.find((c) => c.id === cur?.status)?.category;
        if (cat === CATEGORY.WORKING)
          throw new Error(`review turn dispatch failed before the round opened — ${reason}`);
      }
    }
    return; // SEQUENTIAL: one turn in flight — the next fires from this verdict's settle
  }
}

/** verdict audit line; AI verdicts skip the thread copy — the run bubble carries
 * the verdict (one response per turn, owner ruling 2026-10-29) */
async function logVerdict(
  taskId: string,
  reviewerId: string,
  note: string,
  meta: Record<string, unknown>,
  source: 'human' | 'ai',
) {
  await logActivity(taskId, ACTIVITY_KIND.VERDICT, reviewerId, note, meta, db, {
    thread: source !== 'ai',
  });
}

/** terminal-category status ids, resolved fresh so the flip predicate is evaluated
 * in SQL at WRITE time — never a stale read and never seeded ids only (#260). */
async function terminalStatusIds(): Promise<string[]> {
  const statuses = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
  return statuses.filter((s) => s.category === CATEGORY.DONE || s.category === CATEGORY.CANCELLED).map((s) => s.id);
}

/** waiting_answer-category status ids, resolved fresh (#288): the settle flip
 * refuses them — waiting_answer owns the flow, a question can never be stomped. */
async function waitingAnswerStatusIds(): Promise<string[]> {
  const statuses = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
  return statuses.filter((s) => s.category === CATEGORY.WAITING_ANSWER).map((s) => s.id);
}

/** END-OF-ROUND FLIP CAS (#260): the settle flip is a conditional write refusing
 * done/cancelled-category statuses — a manual settle that lands between this
 * verdict's row write and the flip wins the race, keeps the owner's status and
 * makes the verdict a recorded-but-superseded audit row (returns false).
 * #288: the gate ALSO refuses waiting_answer-category statuses — a verdict
 * settling over an open question would orphan the ANSWER obligation and kill the
 * question thread; the refused flip re-checks and parks (hold arm below). */
async function flipTask(taskId: string, status: string): Promise<boolean> {
  const flipped = await db
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        notInArray(tasks.status, [...(await terminalStatusIds()), ...(await waitingAnswerStatusIds())]),
      ),
    )
    .returning({ id: tasks.id });
  return flipped.length > 0;
}

/** WAITING-ANSWER HOLD (#288): the task is in a waiting_answer category at settle
 * time — the round parks instead of flipping. The settling verdict's row returns
 * to PENDING (scoped to THIS reviewer+round, only while it still carries this
 * verdict — a concurrent teardown/escalation moving the row makes the revert miss
 * and we keep our hands off: the round's own path owns it, never a foreign-state
 * clobber); the ANSWER obligation and the waiting_answer status stay untouched;
 * the thread notes the park. The answer's unblock re-dispatches the held reviewer
 * (row PENDING again) and the round then settles normally on a live in-review
 * task. Returns false when the task is not waiting_answer (normal settle). */
async function holdVerdictForWaitingAnswer(
  taskId: string,
  reviewerId: string,
  verdict: ReviewVerdict,
  source: 'human' | 'ai',
  round: number,
): Promise<boolean> {
  const cur = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!cur) return false;
  const cats = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
  const cat = cats.find((c) => c.id === cur.status)?.category;
  if (cat !== CATEGORY.WAITING_ANSWER) return false;
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.PENDING, note: null, decidedAt: null, source: null })
    .where(
      and(
        eq(taskReviews.taskId, taskId),
        eq(taskReviews.round, round),
        eq(taskReviews.reviewerId, reviewerId),
        eq(taskReviews.status, verdict),
      ),
    );
  // the revert re-opens the round: the held reviewer owes their vote again —
  // re-spawn the APPROVAL obligation so inbox/decision surfaces re-arm for HUMAN
  // reviewers too (the verdict CAS resolved it; spawnObligation dedupes a PENDING
  // duplicate, so a rapid re-vote cannot stack rows). The spawn deliberately runs
  // BEFORE the status re-read below: a settle landing inside the spawn window
  // leaves our row PENDING at its own teardown (supersede + obligation cancel run
  // natively), and a settle already landed by the re-read hits the heal arm — whose
  // cancel then removes whatever the spawn inserted. Either ordering self-heals.
  await spawnObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL);
  // IN-WINDOW RESCUE/HEAL (#288 r1/r2/r3): the holder's answer OR the owner's
  // settle may have landed between the hold's status read and this revert:
  //  - an answer flipped the task off waiting_answer believing the round dead (its
  //    openRoundLive read predates the revert) — restore the round's home (guarded
  //    ready->in_review flip) and re-fire the held reviewer; IN_REVIEW needs no
  //    arm: whatever writer flipped it there (answer flip, owner unblock) runs its
  //    own dispatch — the hold never becomes a second dispatch source;
  //  - a manual settle (done/cancelled category — or the task vanished) won the
  //    race: teardown ran while our row was DECIDED (it supersedes PENDING rows
  //    only), so heal — supersede the just-reverted row and cancel the APPROVAL
  //    obligations the teardown skipped, including anything the spawn above
  //    inserted. Never resurrect state on a settled task.
  const after = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  const afterCat = after ? cats.find((c) => c.id === after.status)?.category : undefined;
  if (!after || afterCat === CATEGORY.DONE || afterCat === CATEGORY.CANCELLED) {
    await db
      .update(taskReviews)
      .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
      .where(
        and(
          eq(taskReviews.taskId, taskId),
          eq(taskReviews.round, round),
          eq(taskReviews.reviewerId, reviewerId),
          eq(taskReviews.status, REVIEW_STATUS.PENDING),
        ),
      );
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE); // the heal's row/obligation changes must reach live clients
    return true; // the owner's settle owns the outcome — nothing held anymore
  }
  if (after.status !== cur.status) {
    const readyIds = cats.filter((c) => c.category === CATEGORY.READY).map((c) => c.id);
    if (readyIds.includes(after.status)) {
      const restored = await db
        .update(tasks)
        .set({ status: IN_REVIEW_STATUS, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), inArray(tasks.status, readyIds)))
        .returning({ id: tasks.id });
      if (restored.length > 0) {
        await dispatchAiReviewTurns(taskId); // we made this flip — we own its re-fire
      } else {
        // the restore flip lost (the task moved again mid-window): the owner owns
        // it now — say so, the manual unblock to in-review re-fires the held turn
        await logActivity(
          taskId,
          ACTIVITY_KIND.STATUS,
          null,
          'review round resumed — the answer landed while a verdict was held; the task moved again, owner unblock to in-review re-fires the held reviewer',
          { reviewResumed: true, round },
        );
      }
    } else if (afterCat === CATEGORY.IN_REVIEW) {
      // r5: the flip writer's own re-fire can predate OUR revert (its row read saw
      // the verdict decided and minted nothing) — this call runs after the revert,
      // so its row read always sees the held row PENDING again. The flip writer's
      // own duplicate is absorbed: the live-turn check bounds it and the verdict
      // CAS arbitrates the settle.
      await dispatchAiReviewTurns(taskId);
    } else {
      // working / other non-terminal: the owner or the answer's own flip owns the
      // task — no fight, no second dispatch source. Say what happened: while a run
      // is live the RUN LOCK blocks the owner's unblock, so the note is the only
      // signal until the run settles.
      await logActivity(
        taskId,
        ACTIVITY_KIND.STATUS,
        null,
        'review round resumed — the answer landed while a verdict was held; the task moved again, owner unblock to in-review re-fires the held reviewer',
        { reviewResumed: true, round },
      );
    }
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE); // re-opened round/obligation must reach live clients
    return true; // held mid-flight, then resumed — outcome stays 'parked'
  }
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    null,
    'review round parked — verdict arrived while the task is waiting for an answer; it re-fires when the answer lands (owner unblock works too)',
    { reviewParked: true, why: 'waiting_answer owns the flow', round, source },
  );
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return true;
}

/** write one reviewer's verdict, then apply the END-OF-ROUND matrix. A round never
 * closes early: a request_change (or a split vote) waits for the remaining reviewers;
 * the LAST verdict triggers the transition. Unanimity is judged over the LIVE set —
 * escalated/superseded rows never count. Fires the next sequential reviewer when the
 * round is still waiting. */
export async function recordVerdict(
  taskId: string,
  reviewerId: string,
  verdict: ReviewVerdict,
  note: string,
  source: 'human' | 'ai',
  at?: Date,
): Promise<{ outcome: 'waiting' | 'done' | 'returned' | 'cancelled' | 'superseded' | 'parked' }> {
  const taskRow = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!taskRow) throw new Error('task not found');
  // terminal gate: a settled (done/cancelled) task must never be moved by a verdict
  // that arrives late — stale AI runs and post-abandon clicks land here.
  // CATEGORY-GATE LAW (#336): the gate resolves the CATEGORY, so a custom terminal
  // status refuses exactly like the seeded one.
  const verdictCategory = await categoryOf(taskRow.status);
  if (verdictCategory === CATEGORY.DONE || verdictCategory === CATEGORY.CANCELLED)
    throw new Error('task already settled — late verdict refused');
  // round binding: a human click decides the CURRENT round; an AI verdict belongs to
  // the round its review run was DISPATCHED for (a stale run must not settle a newer
  // round it was never part of)
  // `at` pins the SETTLING run's start for AI verdicts (#276 blind-review r6): the
  // verdict binds to the round its run was minted for, exactly like the verdict-less
  // bound — a stale settle must never write into a newer round's row.
  const round = source === 'human' ? await currentRound(taskId) : await dispatchedReviewRound(taskId, reviewerId, at);
  if (round === 0) throw new Error('task has no open review round');
  const row = (
    await db
      .select()
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.reviewerId, reviewerId)))
  )[0];
  if (!row) throw new Error('not a reviewer in the current round');
  if (row.status !== REVIEW_STATUS.PENDING) throw new Error('verdict already recorded for this round');
  // VERDICT CAS (#260): the write is its own arbiter — a concurrent double-submit
  // or a manual-settle teardown (rows superseded) landing between the read above
  // and this write makes the CAS miss (0 rows) and the late verdict is refused.
  const settled = await db
    .update(taskReviews)
    .set({ status: verdict, note: note || null, decidedAt: new Date(), source })
    .where(and(eq(taskReviews.id, row.id), eq(taskReviews.status, REVIEW_STATUS.PENDING)))
    .returning({ id: taskReviews.id });
  if (settled.length === 0) throw new Error('verdict already recorded for this round');
  /* v8 ignore next -- the obligation always exists for a verdict author; the
   * catch only guards a race with a concurrent round close */
  await resolveObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, reviewerId).catch(() => {});
  return settleRound(taskId, reviewerId, verdict, note, source, round);
}

/** END-OF-ROUND MATRIX (recordVerdict's tail): read the round fresh — the verdict
 * already landed, so any PENDING row here belongs to another reviewer whose turn is
 * still owed. Settles only on the LAST verdict; flips ride the #260 CAS. */
async function settleRound(
  taskId: string,
  reviewerId: string,
  verdict: ReviewVerdict,
  note: string,
  source: 'human' | 'ai',
  round: number,
): Promise<{ outcome: 'waiting' | 'done' | 'returned' | 'cancelled' | 'superseded' | 'parked' }> {
  const roundRows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  const pending = roundRows.filter((r) => r.status === REVIEW_STATUS.PENDING && r.reviewerId !== null);
  if (pending.length > 0) {
    // round still waiting — advance the sequence (lazy mint: the settle path fires
    // the next reviewer's turn; humans just keep their card)
    await logVerdict(
      taskId,
      reviewerId,
      note || verdict.toLowerCase(),
      {
        [verdict === REVIEW_STATUS.APPROVED
          ? 'approved'
          : verdict === REVIEW_STATUS.REJECTED
            ? 'rejected'
            : 'changeRequested']: true,
        round,
      },
      source,
    );
    await dispatchAiReviewTurns(taskId);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    return { outcome: 'waiting' };
  }
  // no live voter left — void pending rows (a reviewer deleted mid-round, #365) are
  // non-votes: extinguish them so the round reads closed and the matrix judges the
  // decided rows only. A manual move or settle can never mint this shape.
  if (roundRows.some(voidPending)) await extinguishVoidPendingRows(taskId, round);
  // every live row decided — unanimity over the LIVE set (escalated/superseded and
  // void pending rows are non-votes and can be the reason `decided` is empty for a
  // torn-down round)
  const live = roundRows.filter(
    (r) => r.status !== REVIEW_STATUS.ESCALATED && r.status !== REVIEW_STATUS.SUPERSEDED && !voidPending(r),
  );
  const allApproved = live.length > 0 && live.every((r) => r.status === REVIEW_STATUS.APPROVED);
  const allRejected = live.length > 0 && live.every((r) => r.status === REVIEW_STATUS.REJECTED);

  // WAITING-ANSWER HOLD (#288): waiting_answer owns the flow — a settling verdict
  // parks the round instead of flipping the task (obligation intact, status stays
  // waiting_answer; the answer's unblock re-fires the held reviewer)
  if (await holdVerdictForWaitingAnswer(taskId, reviewerId, verdict, source, round)) return { outcome: 'parked' };

  if (allRejected) {
    if (!(await flipTask(taskId, CANCELLED_STATUS)))
      return (await holdVerdictForWaitingAnswer(taskId, reviewerId, verdict, source, round))
        ? { outcome: 'parked' }
        : { outcome: 'superseded' };
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
    await supersedeAllPendingRows(taskId); // #361 r6: no pending row outlives a terminal task
    await logVerdict(taskId, reviewerId, note || 'rejected — task cancelled', { rejected: true, round }, source);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    return { outcome: 'cancelled' };
  }
  if (allApproved) {
    if (!(await flipTask(taskId, DONE_STATUS)))
      return (await holdVerdictForWaitingAnswer(taskId, reviewerId, verdict, source, round))
        ? { outcome: 'parked' }
        : { outcome: 'superseded' };
    await cancelObligations(taskId, OBLIGATION_ROLE.APPROVAL);
    await supersedeAllPendingRows(taskId); // #361 r6: no pending row outlives a terminal task
    await logVerdict(
      taskId,
      reviewerId,
      note || REVIEW_STATUS.APPROVED,
      { approved: true, unanimous: true, round },
      source,
    );
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    return { outcome: 'done' };
  }
  // any request_change — or a split approve/reject — bounces the task to the
  // assignee; the verdict notes already sit on the thread and ride the next brief
  if (!(await flipTask(taskId, TODO_STATUS)))
    return (await holdVerdictForWaitingAnswer(taskId, reviewerId, verdict, source, round))
      ? { outcome: 'parked' }
      : { outcome: 'superseded' };
  await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  await logVerdict(taskId, reviewerId, note || 'changes requested', { changeRequested: true, round }, source);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return { outcome: 'returned' };
}

/** reviews list for the task page checklist */
export async function listReviews(taskId: string) {
  const rows = await db.query.taskReviews.findMany({
    columns: {
      reviewerId: true,
      round: true,
      status: true,
      note: true,
      source: true,
      decidedAt: true,
      createdAt: true,
    },
    where: { taskId: { eq: taskId } },
    orderBy: { round: 'asc' },
  });
  return rows.map((r) => ({
    reviewerId: r.reviewerId,
    round: r.round,
    status: r.status as ReviewStatus,
    note: r.note,
    source: r.source,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** MINT SELF-HEAL (#292 r2/r3): the escalate mint spans four awaited writes with no
 * single arbiter — a SETTLE landing inside the window must never leave the freshly
 * minted target row + obligation alive on a terminal task. Gated on the task being
 * in a done/cancelled CATEGORY (a BLOCKED round is still live — healing it would
 * strand the parked round); the standard teardown supersedes PENDING rows, cancels
 * approval obligations and the roster reverts. A vanished task heals nothing. */
async function selfHealEscalationIfSettled(taskId: string, originalReviewers: string[]): Promise<boolean> {
  const postGate = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (postGate == null) return false;
  const cats = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
  const cat = cats.find((c) => c.id === postGate.status)?.category;
  if (cat !== CATEGORY.DONE && cat !== CATEGORY.CANCELLED) return false;
  await teardownOpenRound(taskId, 'escalation lost the race');
  await db.update(tasks).set({ reviewers: originalReviewers, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return true;
}

/** parse "escalate to <name> for reviewing — <why>" into target name + reason.
 * Null name when the body carries no explicit target — the caller then picks the
 * direct supervisor. */
export function parseEscalationNote(body: string): { targetName: string | null; why: string } {
  const m = body.match(/escalate\s+to\s+([^,;—-]+?)\s+for\s+reviewing\s*[—:-]?\s*(.*)/i);
  if (!m) return { targetName: null, why: body.trim() };
  return { targetName: nonNull(m[1]).trim(), why: (nonNull(m[2]) || '').trim() || body.trim() };
}

/** ESCALATION STALL (#370): park the round on the owner — unless the escalator was
 *  deleted mid-turn, in which case the removal owns the round and the resume arm runs
 *  instead of parking a round the run no longer owns. */
async function parkEscalationStall(taskId: string, reviewerId: string, why: string) {
  const stillThere = await db.query.user.findFirst({ columns: { id: true }, where: { id: { eq: reviewerId } } });
  if (!stillThere) {
    await resumeReviewQueueAfterRemoval(taskId);
    return;
  }
  await parkRound(taskId, `review escalation stalled — ${why || 'no eligible supervisor to escalate to'}`);
}

/** REVIEW REFERRAL (final spec 2026-10-29): the reviewer steps aside and their
 * supervisor takes the vote. Mutates the TASK's reviewer roster (escalator out,
 * replacement in — one source of truth), flips the row to `escalated` (audit,
 * never counts) and opens a fresh PENDING row in the SAME round for the target.
 * Target rules: up-chain of the escalator only — never the assignee, never self,
 * never an existing reviewer of the round; a supervisor who IS the assignee is
 * skipped walking up; no eligible target (or unparseable body) parks the round on
 * the owner instead. `escalate` NEVER settles anything. */
export async function escalateReview(
  taskId: string,
  reviewerId: string,
  body: string,
): Promise<{ outcome: 'escalated' | 'parked' | 'superseded' }> {
  const task = (
    await db
      .select({ status: tasks.status, reviewers: tasks.reviewers, assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
  )[0];
  if (!task) throw new Error('task not found');
  // CATEGORY-GATE LAW (#336): escalation gates on the in-review CATEGORY, so a
  // custom in-review status escalates exactly like the seeded one.
  if ((await categoryOf(task.status)) !== CATEGORY.IN_REVIEW) throw new Error('task is not in review');
  const round = await currentRound(taskId);
  if (round === 0) throw new Error('task has no open review round');
  const row = (
    await db
      .select()
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.reviewerId, reviewerId)))
  )[0];
  if (!row || row.status !== REVIEW_STATUS.PENDING) throw new Error('not a pending reviewer in the current round');

  const { targetName, why } = parseEscalationNote(body);
  const users = await db.query.user.findMany({ columns: { id: true, name: true } });
  const byName = new Map(users.map((u) => [u.name, u.id] as const));
  const edges = await db.query.employeeSupervisors.findMany({
    columns: { employeeId: true, supervisorId: true },
  });
  // up-chain of the ESCALATOR, nearest first; a supervisor who is the assignee is
  // skipped (self-review), so is the escalator themself and existing round reviewers
  const roundRows = await db
    .select({ reviewerId: taskReviews.reviewerId })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  const onRound = new Set(roundRows.map((r) => r.reviewerId));
  const chain: string[] = [];
  // (onRound guards the named-target check below — a reviewer already on the round
  // can never be picked, even if they sit up-chain)
  let cursor: string | undefined = reviewerId;
  const seen = new Set<string>([reviewerId]);
  while (cursor) {
    const supers = edges.filter((e) => e.employeeId === cursor).map((e) => e.supervisorId);
    const next = supers.find((s0) => !seen.has(s0));
    if (!next) break;
    seen.add(next);
    if (next !== task.assigneeId) chain.push(next); // assignee never reviews their own work
    cursor = next;
  }
  let targetId: string | undefined;
  if (targetName) {
    const named = byName.get(targetName);
    if (named && chain.includes(named) && !onRound.has(named)) targetId = named;
  }
  /* v8 ignore next -- a fresh chain always has a head when a supervisor edge exists */
  targetId = targetId ?? chain[0];
  if (!targetId) {
    // no eligible up-chain target: the round parks on the owner with the why intact —
    // unless the escalator was deleted mid-turn (#370): the removal owns that round.
    await parkEscalationStall(taskId, reviewerId, why);
    return { outcome: 'parked' };
  }

  const targetName2 = nonNull(users.find((u) => u.id === targetId)).name;
  // VERDICT CAS (#260 sibling, #283): the escalator's row flip is its own arbiter —
  // a verdict that won the race (recordVerdict) or a teardown that superseded the row
  // lands here as a 0-row miss: refuse the escalation and mint nothing (no roster
  // mutation, no target row, no obligation — a settled task never gains a reviewer).
  const escalated = await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.ESCALATED, note: body || null, decidedAt: new Date(), source: 'ai' })
    .where(and(eq(taskReviews.id, row.id), eq(taskReviews.status, REVIEW_STATUS.PENDING)))
    .returning({ id: taskReviews.id });
  if (escalated.length === 0) throw new Error('verdict already recorded for this round');
  // roster mutation IS the handoff (one source of truth): the escalator leaves the
  // task, the replacement joins it — written only once the row flip won
  await db
    .update(tasks)
    .set({
      reviewers: [...task.reviewers.filter((r) => r !== reviewerId), targetId],
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  await db
    .insert(taskReviews)
    .values({ id: uuidv7(), taskId, reviewerId: targetId, round, status: REVIEW_STATUS.PENDING });
  await resolveObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, reviewerId).catch(() => {});
  await spawnObligation(taskId, targetId, OBLIGATION_ROLE.APPROVAL, new Date());
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    reviewerId,
    `review escalated to ${targetName2}${why ? ` — ${why}` : ''}`,
    { escalated: true, from: reviewerId, to: targetId, round },
  );
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  if (await selfHealEscalationIfSettled(taskId, task.reviewers)) return { outcome: 'superseded' };
  await dispatchAiReviewTurns(taskId);
  return { outcome: 'escalated' };
}

/** park the round: the task cannot progress without a human. The task flips to
 * BLOCKED (system, not reviewer), the why lands on the thread, and the round stays
 * exactly as it is — owner resolution unblocks and the sequence resumes.
 * PARK-REARM LAW (#211): an infra-class park (opts.rearmable — mint failure, failed
 * or timed-out review turn, verdict-settle throw) is machine-recoverable and schedules
 * a bounded re-arm on the ladder; a decision park (default) resets the ledger and
 * schedules nothing — owner resolution stays the only resume. Attempts survive the
 * restore (the unblock arm never rewrites them), so a re-fire cycle is bounded; the
 * columns are inert off BLOCKED and every park write rewrites them.
 * Returns whether the park flip WON (the task was still in-review) — callers use
 * the miss to detect the round-open window (#282). */
export const PARK_REARM_LADDER_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;

export async function parkRound(taskId: string, why: string, opts: { rearmable?: boolean } = {}): Promise<boolean> {
  const task = (
    await db
      .select({ status: tasks.status, ownerId: tasks.ownerId, rearmAttempts: tasks.parkRearmAttempts })
      .from(tasks)
      .where(eq(tasks.id, taskId))
  )[0];
  if (!task) throw new Error('task not found');
  // park only from in-review (#199): a manual settle that won the race owns the
  // outcome — parking over a terminal/owner-moved status would resurrect a dead round.
  // CATEGORY-GATE LAW (#336): the gate reads the in-review CATEGORY (a custom
  // in-review status parks too — the seeded-id gate silently missed and wedged the
  // round), and the guarded write pins the status id it READ so any concurrent move
  // still wins.
  if ((await categoryOf(task.status)) !== CATEGORY.IN_REVIEW) return false;
  const rearmable = opts.rearmable === true;
  // attempts = parks burned in the current cycle; ladder[attempts-1] schedules the
  // next re-fire; past the ladder the round parks FINAL (after = null) and the
  // watchdog alerts the exhausted shape
  const attempts = rearmable ? Math.min(task.rearmAttempts + 1, PARK_REARM_LADDER_MS.length + 1) : 0;
  const rearmAfter =
    rearmable && attempts <= PARK_REARM_LADDER_MS.length
      ? new Date(Date.now() + nonNull(PARK_REARM_LADDER_MS[attempts - 1]))
      : null;
  const parkedRows = await db
    .update(tasks)
    // park-origin memory (#202): the BLOCKED flip carries the status it flipped from —
    // the parent-gating unblock restores this, never a stale pre_block_status
    .set({
      status: BLOCKED_STATUS,
      parkFromStatus: task.status,
      updatedAt: new Date(),
      parkRearmAttempts: attempts,
      parkRearmAfter: rearmAfter,
    })
    // atomic re-check: a settle/status change between read and write wins — the
    // predicate pins the status id this call READ (CATEGORY-GATE LAW #336), so a
    // custom in-review status parks and a concurrent move still beats the park
    .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
    .returning({ id: tasks.id });
  if (parkedRows.length === 0) return false;
  await logActivity(taskId, ACTIVITY_KIND.STATUS, null, `review parked — ${why}`, {
    reviewParked: true,
    why,
    fromStatus: task.status,
    ...(rearmable ? { rearm: { attempt: attempts, rearmAfter: rearmAfter?.toISOString() ?? null } } : {}),
  });
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return true;
}

/** OBLIGATION LIFECYCLE (#205): a PENDING obligation must never outlive the
 * state that makes it actionable. The owner's manual move is the verdict of
 * record, so setStatus resolves status CATEGORIES — never seeded ids:
 *  - settling into ANY done/cancelled-category status (seeded or custom) tears
 *    the round down and cancels every PENDING obligation (both roles). The old
 *    seeded-id guard skipped custom terminal statuses entirely;
 *  - leaving the waiting_answer category cancels PENDING ANSWER obligations —
 *    a round-0 (question-flow) task early-returns in teardownOpenRound, so its
 *    ANSWER obligation otherwise survives the settle forever (phantom inbox). */
export async function teardownOnManualMove(taskId: string, fromStatus: string, toStatus: string) {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    orderBy: { position: 'asc' },
  });
  const byId = new Map(statuses.map((s) => [s.id, s.category]));
  const from = byId.get(fromStatus);
  const to = byId.get(toStatus);
  if (to === CATEGORY.DONE || to === CATEGORY.CANCELLED) {
    if (from !== to) {
      await teardownOpenRound(taskId, toStatus);
      // question-flow tasks (round 0) skip teardownOpenRound; any stale ANSWER
      // obligation dies with the settle regardless of review state
      await cancelAllObligations(taskId, OBLIGATION_ROLE.ANSWER);
    }
    return;
  }
  if (from === CATEGORY.WAITING_ANSWER && to !== CATEGORY.WAITING_ANSWER) {
    await cancelAllObligations(taskId, OBLIGATION_ROLE.ANSWER);
  }
}

/** MANUAL SETTLE teardown: the owner moved the task to a terminal status — the
 * round dies with it. PENDING rows become `superseded` (audit, non-vote), approval
 * obligations cancel, and the note lands on the thread. Decided/escalated rows stay
 * untouched as history. `ex` (#397): the caller may fold the teardown into its own
 * transaction — abandon arbitrates its cancel AND this teardown in ONE transaction, so
 * a lost abandon tears down nothing. */
export async function teardownOpenRound(taskId: string, settledTo: string, ex: DbExecutor = db) {
  const d = asDb(ex);
  // the task's MAX round is the LIVE round at its call sites, and a round only ever
  // reaches the ledger through a WON submit flip (#394 — the flip and the round rows
  // commit in one transaction), so no dead round can sit above the live one: the
  // manual settle tears down AFTER its status write, the escalation self-heal is gated
  // on a done/cancelled task, and abandon (#397) now tears down only after its own
  // cancel CAS won — inside the same transaction.
  const round = await currentRound(taskId, ex);
  if (round === 0) return;
  const rows = await d
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  const pendingIds = rows.filter((r) => r.status === REVIEW_STATUS.PENDING).map((r) => r.id);
  if (pendingIds.length) {
    await d
      .update(taskReviews)
      .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
      .where(
        and(
          eq(taskReviews.taskId, taskId),
          eq(taskReviews.round, round),
          eq(taskReviews.status, REVIEW_STATUS.PENDING),
        ),
      );
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL, ex);
  }
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    null,
    'review round closed — task settled',
    {
      roundClosed: true,
      round,
      settledTo,
    },
    ex,
  );
}

/** the current round's decided verdicts, rendered for the next reviewer's brief —
 * sequential reviewers vote informed, never blind (final spec 2026-10-29) */
export async function verdictsSoFarFor(taskId: string): Promise<string[]> {
  const round = await currentRound(taskId);
  if (round === 0) return [];
  const rows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  const decided = rows.filter(
    (r) =>
      r.status === REVIEW_STATUS.APPROVED ||
      r.status === REVIEW_STATUS.REJECTED ||
      r.status === REVIEW_STATUS.CHANGE_REQUESTED,
  );
  if (!decided.length) return [];
  const users = await db.query.user.findMany({ columns: { id: true, name: true } });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return decided.map((r) => {
    const who = r.reviewerId ? (nameById.get(r.reviewerId) ?? 'reviewer') : 'reviewer';
    const verb =
      r.status === REVIEW_STATUS.APPROVED
        ? 'approved'
        : r.status === REVIEW_STATUS.REJECTED
          ? 'rejected'
          : 'requested changes';
    return `${who} ${verb}${r.note ? `: ${r.note}` : ''}`;
  });
}
