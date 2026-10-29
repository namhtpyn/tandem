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
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskReviews, taskRuns, taskMessages } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { spawnObligation, cancelObligations, cancelAllObligations, resolveObligation } from './obligations.service';
import { dispatchTask } from './runner.service';
import { insertActivityMessage } from './thread.service';

export type ReviewVerdict = Exclude<ReviewStatus, typeof REVIEW_STATUS.PENDING>;

import {
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
  const { taskActivity } = await import('../../db/schema');
  await asDb(ex).insert(taskActivity).values({ id: uuidv7(), taskId, authorId, kind, body, meta });
  // dual-write: the conversation thread carries the same item (payload keeps the kind).
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
 * from settling a newer round it was never part of. */
async function dispatchedReviewRound(taskId: string, reviewerId: string) {
  const runRows = await db
    .select({ startedAt: taskRuns.startedAt })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.employeeId, reviewerId)))
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  const startedAt = runRows[0]?.startedAt;
  if (!startedAt) return 0;
  const rows = await db
    .select({ round: taskReviews.round, createdAt: taskReviews.createdAt })
    .from(taskReviews)
    .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.reviewerId, reviewerId)))
    .orderBy(desc(taskReviews.round));
  // rounds are minted in order; the dispatched round is the newest one open at run start
  return rows.find((r) => r.createdAt.getTime() <= startedAt.getTime())?.round ?? 0;
}

/** open a fresh review round: one pending row per reviewer + inbox obligations.
 * Called by submitResult. The task parks in-review; AI reviewers get review turns. */
export async function openReviewRound(taskId: string, reviewers: string[], resultBody: string) {
  const uniqueReviewers = dedupeReviewers(reviewers);
  const round = (await currentRound(taskId)) + 1;
  const now = new Date();
  for (const reviewerId of uniqueReviewers) {
    await db
      .insert(taskReviews)
      .values({ id: uuidv7(), taskId, reviewerId, round, status: REVIEW_STATUS.PENDING, createdAt: now });
    await spawnObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, now);
  }
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    null,
    `review round ${round} opened — waiting on ${uniqueReviewers.length} reviewer(s)`,
    { reviewRound: round },
  );
  await dispatchAiReviewTurns(taskId, resultBody);
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

/** the submitted result the current round is judging (latest submit activity body) */
async function latestSubmittedBody(taskId: string) {
  const { taskActivity } = await import('../../db/schema');
  const rows = await db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(desc(taskActivity.createdAt))
    .limit(50);
  const submitted = rows.find(
    (a) => a.kind === ACTIVITY_KIND.VERDICT && (a.meta as Record<string, unknown> | null)?.submitted,
  );
  /* v8 ignore next -- the submit activity always carries a body in practice */
  return submitted?.body ?? '';
}

/** fire the NEXT pending AI reviewer's turn — exactly one per call (sequential law:
 * one review turn in flight per task; the verdict's settle path lazy-mints the next).
 * Round order = row order. Human reviewers are skipped (the card is their UI).
 * Sessions are per (task, reviewer) — never the assignee's session. */
export async function dispatchAiReviewTurns(taskId: string, resultBody?: string) {
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
  const body = resultBody ?? (await latestSubmittedBody(taskId));
  for (const row of rows) {
    if (!row.reviewerId || !aiIds.has(row.reviewerId)) continue; // human reviewer: the card is enough
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
      await dispatchTask(taskId, 'http://tandem.internal', { reviewBy: row.reviewerId, resultBody: body });
      await logActivity(taskId, ACTIVITY_KIND.STATUS, null, `review turn dispatched to reviewer ${row.reviewerId}`, {
        reviewTurn: true,
        reviewerId: row.reviewerId,
        round,
      });
    } catch (e) {
      /* v8 ignore next 2 -- best-effort: a review-dispatch failure logs and the human card remains */
      await logActivity(
        taskId,
        ACTIVITY_KIND.STATUS,
        null,
        `review turn failed to dispatch: ${e instanceof Error ? e.message : String(e)}`,
        { reviewTurnFailed: true, reviewerId: row.reviewerId, round },
      );
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
): Promise<{ outcome: 'waiting' | 'done' | 'returned' | 'cancelled' }> {
  const taskRow = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!taskRow) throw new Error('task not found');
  // terminal gate: a settled (done/cancelled) task must never be moved by a verdict
  // that arrives late — stale AI runs and post-abandon clicks land here
  if (taskRow.status === DONE_STATUS || taskRow.status === CANCELLED_STATUS)
    throw new Error('task already settled — late verdict refused');
  // round binding: a human click decides the CURRENT round; an AI verdict belongs to
  // the round its review run was DISPATCHED for (a stale run must not settle a newer
  // round it was never part of)
  const round = source === 'human' ? await currentRound(taskId) : await dispatchedReviewRound(taskId, reviewerId);
  if (round === 0) throw new Error('task has no open review round');
  const row = (
    await db
      .select()
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, taskId), eq(taskReviews.round, round), eq(taskReviews.reviewerId, reviewerId)))
  )[0];
  if (!row) throw new Error('not a reviewer in the current round');
  if (row.status !== REVIEW_STATUS.PENDING) throw new Error('verdict already recorded for this round');
  await db
    .update(taskReviews)
    .set({ status: verdict, note: note || null, decidedAt: new Date(), source })
    .where(eq(taskReviews.id, row.id));
  /* v8 ignore next -- the obligation always exists for a verdict author; the
   * catch only guards a race with a concurrent round close */
  await resolveObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, reviewerId).catch(() => {});

  // END-OF-ROUND MATRIX: read the round fresh — this verdict already landed, so any
  // PENDING row here belongs to another reviewer whose turn is still owed
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

  if (allRejected) {
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
    await db.update(tasks).set({ status: CANCELLED_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await logVerdict(taskId, reviewerId, note || 'rejected — task cancelled', { rejected: true, round }, source);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    return { outcome: 'cancelled' };
  }
  if (allApproved) {
    await cancelObligations(taskId, OBLIGATION_ROLE.APPROVAL);
    await db.update(tasks).set({ status: DONE_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId));
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
  await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  await db.update(tasks).set({ status: TODO_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId));
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
  source: 'human' | 'ai',
): Promise<{ outcome: 'escalated' | 'parked' }> {
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
  // roster mutation IS the handoff (one source of truth): the escalator leaves the
  // task, the replacement joins it
  await db
    .update(tasks)
    .set({
      reviewers: [...task.reviewers.filter((r) => r !== reviewerId), targetId],
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  await db
    .update(taskReviews)
    .set({ status: REVIEW_STATUS.ESCALATED, note: body || null, decidedAt: new Date(), source })
    .where(eq(taskReviews.id, row.id));
  await db
    .insert(taskReviews)
    .values({ id: uuidv7(), taskId, reviewerId: targetId, round, status: REVIEW_STATUS.PENDING });
  await resolveObligation(taskId, reviewerId, OBLIGATION_ROLE.APPROVAL, reviewerId).catch(() => {});
  await spawnObligation(taskId, targetId, OBLIGATION_ROLE.APPROVAL, new Date());
  await logActivity(
    taskId,
    ACTIVITY_KIND.STATUS,
    source === 'ai' ? reviewerId : null,
    `review escalated to ${targetName2}${why ? ` — ${why}` : ''}`,
    { escalated: true, from: reviewerId, to: targetId, round },
  );
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  await dispatchAiReviewTurns(taskId);
  return { outcome: 'escalated' };
}

/** park the round: the task cannot progress without a human. The task flips to
 * BLOCKED (system, not reviewer), the why lands on the thread, and the round stays
 * exactly as it is — owner resolution unblocks and the sequence resumes. */
export async function parkRound(taskId: string, why: string) {
  const task = (
    await db.select({ status: tasks.status, ownerId: tasks.ownerId }).from(tasks).where(eq(tasks.id, taskId))
  )[0];
  if (!task) throw new Error('task not found');
  await db.update(tasks).set({ status: BLOCKED_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await logActivity(taskId, ACTIVITY_KIND.STATUS, null, `review parked — ${why}`, { reviewParked: true, why });
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
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
