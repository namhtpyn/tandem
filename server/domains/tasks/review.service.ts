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
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { db, type DbExecutor } from '../../db/index';
import { tasks, taskReviews, taskRuns, taskMessages } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { spawnObligation, cancelObligations, cancelAllObligations, resolveObligation } from './obligations.service';
import { dispatchTask, type DispatchOpts } from './runner.service';
import { insertActivityMessage } from './thread.service';

export type ReviewVerdict = Exclude<ReviewStatus, typeof REVIEW_STATUS.PENDING>;

import {
  CATEGORY,
  CHANGE_RESOURCE,
  CHANGE_ACTION,
  REVIEW_STATUS,
  OBLIGATION_ROLE,
  ACTIVITY_KIND,
  type ActivityKind,
  type ReviewStatus,
  RUN_STATUS,
} from '#shared/enums';
import { STATUS } from '#shared/status';
import { nonNull } from '#shared/utils/non-null';

const TODO_STATUS = STATUS.todo;

const DONE_STATUS = STATUS.done;
const CANCELLED_STATUS = STATUS.cancelled;
const BLOCKED_STATUS = STATUS.blocked;
const IN_REVIEW_STATUS = STATUS.inReview;

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

/** current (max) round for a task; 0 when never reviewed */
export async function currentRound(taskId: string) {
  const rows = await db
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
 * Called by submitResult. The task parks in-review; AI reviewers get review turns. */
export async function openReviewRound(taskId: string, reviewers: string[], resultBody: string) {
  const uniqueReviewers = dedupeReviewers(reviewers);
  const round = (await currentRound(taskId)) + 1;
  const now = new Date();
  for (const reviewerId of uniqueReviewers) {
    await db.insert(taskReviews).values({
      id: uuidv7(),
      taskId,
      reviewerId,
      round,
      status: REVIEW_STATUS.PENDING,
      resultBody,
      createdAt: now,
    });
    await spawnObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, now);
  }
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    null,
    `review round ${round} opened — waiting on ${uniqueReviewers.length} reviewer(s)`,
    { reviewRound: round },
  );
  try {
    await dispatchAiReviewTurns(taskId, resultBody);
  } catch (e) {
    // ROUND-OPEN FAILURE (#282): the contract is a failed round-open leaves the task
    // working with the error surfaced — the just-minted rows supersede and their
    // approval obligations cancel, so no round is left behind for a settle to wedge on.
    await teardownOpenRound(taskId, 'round-open failed');
    throw e;
  }
  return round;
}

/** is the current round still LIVE (pending reviewers)? Rounds never close early —
 * a request_change keeps the round open until the last verdict lands — so LIVE means
 * pending rows exist. Drives where an answered question returns: a live review round
 * goes back to in-review, everything else back to todo. */
export async function openRoundLive(taskId: string) {
  const round = await currentRound(taskId);
  if (round === 0) return false;
  const rows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  return rows.some((r) => r.status === REVIEW_STATUS.PENDING);
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

/** fire the NEXT pending AI reviewer's turn — exactly one per call (sequential law:
 * one review turn in flight per task; the verdict's settle path lazy-mints the next).
 * Round order = row order. Human reviewers are skipped (the card is their UI).
 * Sessions are per (task, reviewer) — never the assignee's session.
 * opts.verdictCorrection (#276): rides ONLY the verdict-less settle path's bounded
 * re-dispatch — the retry brief carries the CORRECTION block. */
export async function dispatchAiReviewTurns(taskId: string, resultBody?: string, opts?: DispatchOpts) {
  const round = await currentRound(taskId);
  if (round === 0) return;
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
    // one LIVE review turn per reviewer: skip while theirs is still running
    const running =
      (
        await db
          .select({ id: taskRuns.id })
          .from(taskRuns)
          .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
          .where(
            and(
              eq(taskMessages.taskId, taskId),
              eq(taskRuns.employeeId, row.reviewerId),
              eq(taskRuns.status, RUN_STATUS.RUNNING),
            ),
          )
      ).length > 0;
    if (running) continue;
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
  // duplicate, so a rapid re-vote cannot stack rows)
  await spawnObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL);
  // IN-WINDOW RESCUE (#288 r1): the holder's answer may have landed between the
  // hold's status read and this revert — its openRoundLive read saw the row still
  // decided, flipped the task off waiting_answer (todo when it believed the round
  // dead) and skipped the re-dispatch. The revert just made the round live again:
  // restore its home (guarded ready->in_review flip) and re-fire the held reviewer,
  // exactly as the unblock path would have.
  const after = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (after && after.status !== cur.status) {
    if (after.status === IN_REVIEW_STATUS) {
      await dispatchAiReviewTurns(taskId); // answer landed post-revert: re-fire (its own live-turn check dedupes)
    } else {
      const readyIds = cats.filter((c) => c.category === CATEGORY.READY).map((c) => c.id);
      if (readyIds.includes(after.status)) {
        const restored = await db
          .update(tasks)
          .set({ status: IN_REVIEW_STATUS, updatedAt: new Date() })
          .where(and(eq(tasks.id, taskId), inArray(tasks.status, readyIds)))
          .returning({ id: tasks.id });
        if (restored.length > 0) await dispatchAiReviewTurns(taskId);
      }
      // any other status (owner moved it mid-window): the owner owns the task — no
      // fight (terminal moves already tore the round down; working moves keep it
      // under the pre-existing manual-move semantics)
    }
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
  // that arrives late — stale AI runs and post-abandon clicks land here
  if (taskRow.status === DONE_STATUS || taskRow.status === CANCELLED_STATUS)
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
  const pending = roundRows.filter((r) => r.status === REVIEW_STATUS.PENDING);
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
  // every live row decided — unanimity over the LIVE set (escalated/superseded are
  // non-votes and can be the reason `decided` is empty for a torn-down round)
  const live = roundRows.filter((r) => r.status !== REVIEW_STATUS.ESCALATED && r.status !== REVIEW_STATUS.SUPERSEDED);
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
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review');
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
    // no eligible up-chain target: the round parks on the owner with the why intact
    await parkRound(taskId, `review escalation stalled — ${why || 'no eligible supervisor to escalate to'}`);
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
  // outcome — parking over a terminal/owner-moved status would resurrect a dead round
  if (task.status !== IN_REVIEW_STATUS) return false;
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
    // atomic re-check: a settle/status change between read and write wins
    .where(and(eq(tasks.id, taskId), eq(tasks.status, IN_REVIEW_STATUS)))
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
 * untouched as history. */
export async function teardownOpenRound(taskId: string, settledTo: string) {
  const round = await currentRound(taskId);
  if (round === 0) return;
  const rows = await db
    .select()
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round)));
  const pendingIds = rows.filter((r) => r.status === REVIEW_STATUS.PENDING).map((r) => r.id);
  if (pendingIds.length) {
    await db
      .update(taskReviews)
      .set({ status: REVIEW_STATUS.SUPERSEDED, decidedAt: new Date() })
      .where(
        and(
          eq(taskReviews.taskId, taskId),
          eq(taskReviews.round, round),
          eq(taskReviews.status, REVIEW_STATUS.PENDING),
        ),
      );
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  }
  await logActivity(taskId, ACTIVITY_KIND.STATUS, null, 'review round closed — task settled', {
    roundClosed: true,
    round,
    settledTo,
  });
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
