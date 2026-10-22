import { eq, asc } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import {
  CHANGE_RESOURCE,
  CHANGE_ACTION,
  REVIEW_STATUS,
  OBLIGATION_ROLE,
  ACTIVITY_KIND,
  type ActivityKind,
} from '#shared/enums';
import { STATUS } from '#shared/status';
// Task workflow service: question → forward chain → answer, and the review
// gate (submit / approve / request-changes / abandon). Pure routing logic the
// router and (later) the dispatcher both call. Laws (user, 2026-10-13):
//   1. owner ≠ supervisor — no hierarchy coupling
//   2. ALL reviewers must approve
//   3. reviewer/assignee: AI or human, no restriction
//   4. forward chain is free but stops at the top of the hierarchy (no
//      supervisors left) — and can't revisit anyone already in the chain
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { tasks, taskActivity, employeeSupervisors } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { refreshParentGating, hasOpenChildren } from './gating.service';
import { spawnObligation, resolveObligation, cancelObligations, answerHolder } from './obligations.service';
import { openRoundLive, dispatchAiReviewTurns, openReviewRound, recordVerdict } from './review.service';

export const WAITING_ANSWER_STATUS = STATUS.waitingAnswer;
export const IN_REVIEW_STATUS = STATUS.inReview;
export const TODO_STATUS = STATUS.todo;
export const DOING_STATUS = STATUS.doing;
export const DONE_STATUS = STATUS.done;
export const CANCELLED_STATUS = STATUS.cancelled;

async function logActivity(
  taskId: string,
  kind: ActivityKind,
  authorId: string | null,
  body: string,
  meta: Record<string, unknown> = {},
) {
  await db.insert(taskActivity).values({ id: uuidv7(), taskId, kind, authorId, body, meta });
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

async function getTask(id: string) {
  const rows = await db.query.tasks.findMany({ where: { id: { eq: id } } });
  if (rows.length === 0) throw new Error('task not found');
  return nonNull(rows[0]);
}

async function hasSupervisors(employeeId: string) {
  const rows = await db
    .select({ supervisorId: employeeSupervisors.supervisorId })
    .from(employeeSupervisors)
    .where(eq(employeeSupervisors.employeeId, employeeId));
  return rows.length > 0;
}

/** assignee asks; holder starts as the owner. status → waiting-answer */
export async function askQuestion(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (!task.assigneeId) throw new Error('task has no assignee');
  const holder = task.ownerId ?? task.createdBy;
  if (!holder) throw new Error('task has no owner to answer');
  // REVIEW LAW: the assignee asks from doing; a REVIEWER may ask from in-review
  // (the round stays open — answering flips back to in-review, the review continues)
  if (task.status !== DOING_STATUS && task.status !== IN_REVIEW_STATUS)
    throw new Error('only a task in progress or review can ask');
  await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER);
  await spawnObligation(taskId, holder, OBLIGATION_ROLE.ANSWER);
  await db
    .update(tasks)
    .set({
      status: WAITING_ANSWER_STATUS,
      questionChain: [holder],
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  await logActivity(taskId, ACTIVITY_KIND.QUESTION, authorId, body, { holderId: holder });
  return { holderId: holder };
}

/** current holder forwards to someone new; they become holder. Top of the org must answer. */
export async function forwardQuestion(taskId: string, authorId: string, toEmployeeId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== WAITING_ANSWER_STATUS) throw new Error('task is not waiting for an answer');
  const holder = await answerHolder(taskId);
  if (holder !== authorId) throw new Error('only the current holder can forward');
  const chain = task.questionChain;
  if (chain.includes(toEmployeeId)) throw new Error('already in the question chain');
  const target = await db.query.user.findFirst({ columns: { name: true }, where: { id: { eq: toEmployeeId } } });
  if (!target) throw new Error('employee does not exist');
  if (!(await hasSupervisors(toEmployeeId)))
    throw new Error('that person is the top of the hierarchy — they should answer');
  await resolveObligation(taskId, nonNull(holder), OBLIGATION_ROLE.ANSWER, authorId);
  await db
    .update(tasks)
    .set({
      questionChain: [...chain, toEmployeeId],
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  await spawnObligation(taskId, toEmployeeId, OBLIGATION_ROLE.ANSWER);
  await logActivity(taskId, ACTIVITY_KIND.FORWARD, authorId, body, { toId: toEmployeeId, toName: target.name });
  return { holderId: toEmployeeId };
}

/** anyone in the chain answers → back to the assignee, status → todo (dispatcher re-fires) */
export async function answerQuestion(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== WAITING_ANSWER_STATUS) throw new Error('task is not waiting for an answer');
  const chain = task.questionChain;
  if (!chain.includes(authorId)) throw new Error('only someone in the question chain can answer');
  await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER);
  // a LIVE review round returns to in-review (the round is still open); the
  // assignee's own question returns to todo so the agent resumes with the answer
  const backTo = (await openRoundLive(taskId)) ? IN_REVIEW_STATUS : TODO_STATUS;
  await db
    .update(tasks)
    .set({
      status: backTo,
      questionChain: [],
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  if (backTo === IN_REVIEW_STATUS) {
    // a review-round question was answered — the AI reviewer's turn re-arms
    await dispatchAiReviewTurns(taskId);
  }
  await logActivity(taskId, OBLIGATION_ROLE.ANSWER, authorId, body, {});
  await refreshParentGating(taskId);
  return { ok: true };
}

/** REVIEW LAW (2026-10-16): a submitted result defaults to the assignee's SUPERVISOR
 * for review — humans and AI employees are equal reviewers. Explicit reviewers (if
 * set) win; a lone top-of-org agent with no supervisor completes as before. Review
 * happens ON the task (never a subtask): task_reviews records per-reviewer
 * verdicts; AI reviewers get a review turn dispatched on this same task. */
async function defaultReviewer(assigneeId: string): Promise<string | null> {
  const rows = await db
    .select({ supervisorId: employeeSupervisors.supervisorId })
    .from(employeeSupervisors)
    .where(eq(employeeSupervisors.employeeId, assigneeId));
  return rows[0]?.supervisorId ?? null;
}

export async function submitResult(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== DOING_STATUS) throw new Error('only a task in progress can submit');
  if (task.assigneeId !== authorId) throw new Error('only the assignee can submit');
  if (await hasOpenChildren(taskId)) throw new Error('task has open subtasks — they must be done or cancelled first');
  let reviewers = task.reviewers;
  if (reviewers.length === 0) {
    /* v8 ignore next -- submit requires an assignee; the null arm is defensive */
    const supervisor = task.assigneeId ? await defaultReviewer(task.assigneeId) : null;
    if (supervisor) {
      // persist so verdict author checks and the UI see the reviewer
      reviewers = [supervisor];
      await db.update(tasks).set({ reviewers, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    }
  }
  const nextStatus = reviewers.length > 0 ? IN_REVIEW_STATUS : DONE_STATUS;
  await db.update(tasks).set({ status: nextStatus, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  if (reviewers.length > 0) await openReviewRound(taskId, reviewers, body);
  await logActivity(taskId, ACTIVITY_KIND.VERDICT, authorId, body, { submitted: true, reviewers });
  await refreshParentGating(taskId);
  return { status: nextStatus };
}

/** reviewer approves — writes the task_reviews row via recordVerdict */
export async function approveReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.APPROVED, body, 'human');
  await refreshParentGating(taskId);
  return { ok: true };
}

/** reviewer rejects — HUMAN-only terminal verdict: task cancelled */
export async function rejectReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.REJECTED, body, 'human');
  return { ok: true };
}

/** reviewer requests changes — task back to the assignee (ready), note rides the next brief */
export async function requestChanges(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.CHANGE_REQUESTED, body, 'human');
  await refreshParentGating(taskId);
  return { ok: true };
}

/** reviewer proposes abandon → owner confirms → cancelled (handled by owner via normal status move or this) */
export async function abandonReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if (task.status !== IN_REVIEW_STATUS) throw new Error('task is not in review');
  const reviewers = task.reviewers;
  const isReviewer = reviewers.includes(authorId);
  const isOwner = task.ownerId === authorId || task.createdBy === authorId;
  if (!isReviewer && !isOwner) throw new Error('only a reviewer or the owner can abandon');
  await cancelObligations(taskId, OBLIGATION_ROLE.APPROVAL);
  await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER);
  // abandoned == cancelled (one terminal, no fake distinction)
  await db.update(tasks).set({ status: CANCELLED_STATUS, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await logActivity(taskId, ACTIVITY_KIND.VERDICT, authorId, body || 'cancelled', { abandon: true });
  await refreshParentGating(taskId);
  return { ok: true };
}

/** activity feed for one task, oldest first */
export async function listActivity(taskId: string) {
  return db
    .select({
      id: taskActivity.id,
      taskId: taskActivity.taskId,
      kind: taskActivity.kind,
      authorId: taskActivity.authorId,
      body: taskActivity.body,
      meta: taskActivity.meta,
      createdAt: taskActivity.createdAt,
    })
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(asc(taskActivity.createdAt));
}
