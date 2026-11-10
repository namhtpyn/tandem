import { consola } from 'consola';
import { eq, and, inArray } from 'drizzle-orm';

import {
  CATEGORY,
  CHANGE_RESOURCE,
  CHANGE_ACTION,
  REVIEW_STATUS,
  RUN_STATUS,
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

import { asDb, db } from '../../db/index';
import { tasks, employeeSupervisors, taskReviews, taskRuns, taskMessages } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { refreshParentGating, hasOpenChildren } from './gating.service';
import {
  spawnObligationTracked,
  resolveObligation,
  cancelObligations,
  cancelAllObligations,
  cancelObligationById,
  answerHolder,
} from './obligations.service';
import {
  openRoundLive,
  dispatchAiReviewTurns,
  parkRound,
  openReviewRound,
  recordVerdict,
  currentRound,
  teardownAllPendingRounds,
  settleExtinguishedRound,
  liveReviewers,
  canonicalStoredUuid,
} from './review.service';
import { normalizeActivityPayload } from './thread.service';

export const WAITING_ANSWER_STATUS = STATUS.waitingAnswer;
export const IN_REVIEW_STATUS = STATUS.inReview;
export const TODO_STATUS = STATUS.todo;
export const DONE_STATUS = STATUS.done;
export const CANCELLED_STATUS = STATUS.cancelled;

const log = consola.withTag('tandem');

async function logActivity(
  taskId: string,
  kind: ActivityKind,
  authorId: string | null,
  body: string,
  meta: Record<string, unknown> = {},
  opts: { thread?: boolean } = {},
) {
  // the thread IS the activity store (task_activity retired 2026-10-30) — every
  // activity lands there with its structured payload, EXCEPT agent result
  // submissions, whose run message already carries the result
  if (opts.thread === false) return;
  const { insertActivityMessage } = await import('./thread.service');
  await insertActivityMessage({ taskId, authorId, body, payload: { kind, ...meta } });
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

async function getTask(id: string) {
  const rows = await db.query.tasks.findMany({
    columns: {
      status: true,
      assigneeId: true,
      ownerId: true,
      createdBy: true,
      questionChain: true,
      reviewers: true,
      updatedAt: true,
    },
    where: { id: { eq: id } },
    orderBy: { createdAt: 'asc' },
  });
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

/** The status row's CATEGORY — lifecycle gates read the category, never the
 * seeded uuid (STATUS FREEDOM + CATEGORY-GATE LAW, SPEC #336): a custom status
 * in a category behaves exactly like its seeded sibling. A dangling status id
 * (no row) resolves to null and is refused by every gate here (dead input). */
async function statusCategoryOf(statusId: string): Promise<string | null> {
  const rows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: statusId } },
    orderBy: { position: 'asc' },
  });
  return rows.find((r) => r.id === statusId)?.category ?? null;
}

/** assignee asks; holder starts as the owner. status → waiting-answer */
export async function askQuestion(taskId: string, authorId: string, body: string) {
  // RETRY-ONCE (#400): a benign concurrent write (title/description save,
  // reassignment, a same-category status move) bumps tasks.updatedAt without
  // touching the lifecycle. The park CAS must not turn that into a failed agent
  // settle, so a lost flip re-reads and re-arbitrates ONCE on the fresh stamp. A
  // terminal write still wins: the second loss refuses with the error surfaced and
  // writes nothing.
  for (let attempt = 0; attempt < 2; attempt++) {
    const task = await getTask(taskId);
    if (!task.assigneeId) throw new Error('task has no assignee');
    const holder = task.ownerId ?? task.createdBy;
    if (!holder) throw new Error('task has no owner to answer');
    // REVIEW LAW: the assignee asks from a working status; a REVIEWER may ask from
    // in-review (the round stays open — answering flips back to in-review, the review
    // continues). CATEGORY-GATE LAW (#336): both gates read the status CATEGORY, so a
    // custom working/in-review status asks exactly like its seeded sibling.
    const askCategory = await statusCategoryOf(task.status);
    if (askCategory !== CATEGORY.WORKING && askCategory !== CATEGORY.IN_REVIEW)
      throw new Error('only a task in progress or review can ask');
    // identity gate: only the assignee, the owner, or a reviewer with a PENDING verdict
    // this round (an AI review turn asks instead of approving — REVIEW LAW) may stall
    // the task; nobody else can park someone else's work
    let isParty = task.assigneeId === authorId || task.ownerId === authorId || task.createdBy === authorId;
    if (!isParty) {
      const round = await currentRound(taskId);
      isParty =
        round > 0 &&
        (
          await db
            .select({ id: taskReviews.id })
            .from(taskReviews)
            .where(
              and(
                eq(taskReviews.taskId, taskId),
                eq(taskReviews.round, round),
                eq(taskReviews.reviewerId, authorId),
                eq(taskReviews.status, REVIEW_STATUS.PENDING),
              ),
            )
        ).length > 0;
    }
    if (!isParty) throw new Error('only the assignee, the owner or a pending reviewer can ask');
    // TERMINAL ARBITRATION + ATOMIC ARBITRATION (#400): the waiting-answer park is the
    // transaction's FIRST write and arbitrates on the status AND updatedAt stamp this
    // attempt read — a won abandon/settle keeps its outcome and the late question
    // refuses, writing NOTHING (no obligation cancel, no spawn, no note). The park
    // AUTHORISES the ANSWER obligation, so flip + cancel + spawn commit in ONE
    // transaction: a crash between them can never leave a waiting-answer task carrying
    // no pending obligation.
    const won = await db.transaction(async (tx) => {
      const d = asDb(tx);
      const parked = await d
        .update(tasks)
        .set({
          status: WAITING_ANSWER_STATUS,
          questionChain: [holder],
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
        .returning({ id: tasks.id });
      if (parked.length === 0) return false;
      await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER, tx);
      await spawnObligationTracked(taskId, holder, OBLIGATION_ROLE.ANSWER, undefined, tx);
      return true;
    });
    if (!won) continue;
    await logActivity(taskId, ACTIVITY_KIND.QUESTION, authorId, body, { holderId: holder });
    return { holderId: holder };
  }
  throw new Error('task state changed during ask — a settle owns the outcome');
}

/** current holder forwards to someone new; they become holder. Top of the org must answer. */
export async function forwardQuestion(taskId: string, authorId: string, toEmployeeId: string, body: string) {
  const task = await getTask(taskId);
  // the gate reads the waiting_answer CATEGORY (status freedom) — the client
  // renders Forward by category, so a custom waiting status forwards too
  // (#265 r3, the answer gate's sibling)
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: task.status } },
  });
  if (statusRows.find((r) => r.id === task.status)?.category !== CATEGORY.WAITING_ANSWER)
    throw new Error('task is not waiting for an answer');
  const holder = await answerHolder(taskId);
  if (holder !== authorId) throw new Error('only the current holder can forward');
  const chain = task.questionChain;
  if (chain.includes(toEmployeeId)) throw new Error('already in the question chain');
  const target = await db.query.user.findFirst({ columns: { name: true }, where: { id: { eq: toEmployeeId } } });
  if (!target) throw new Error('employee does not exist');
  if (!(await hasSupervisors(toEmployeeId)))
    throw new Error('that person is the top of the hierarchy — they should answer');
  // TERMINAL ARBITRATION (#292) binds this lifecycle write too (#369 r3): the chain
  // move arbitrates on the status + updatedAt it read — a concurrent answer-holder
  // return may flip the task out of waiting-answer between the gate and this write,
  // and an unguarded update would then leave a fresh holder row on a task no verb can
  // act on. Nothing has been mutated before this CAS, so a loss is a clean refusal.
  const moved = await db
    .update(tasks)
    .set({
      questionChain: [...chain, toEmployeeId],
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
    .returning({ id: tasks.id });
  if (moved.length === 0) throw new Error('task state changed during forward — retry');
  await resolveObligation(taskId, nonNull(holder), OBLIGATION_ROLE.ANSWER, authorId);
  const spawned = await spawnObligationTracked(taskId, toEmployeeId, OBLIGATION_ROLE.ANSWER);
  // POST-SPAWN ARBITRATION (#369 r4): the CAS guards the chain move, but a concurrent
  // answer-holder return that reads AFTER it can flip the task before this spawn
  // lands — a fresh live-holder obligation would then sit on a task no verb can act
  // on. Undo only OUR row (created this call) when the task left the flow, and refuse.
  const after = await getTask(taskId);
  if ((await statusCategoryOf(after.status)) !== CATEGORY.WAITING_ANSWER) {
    if (spawned.created) {
      try {
        await cancelObligationById(spawned.id);
      } catch {
        // best-effort: the row is ours, and a leftover live row is still visible
      }
    }
    throw new Error('task state changed during forward — retry');
  }
  await logActivity(taskId, ACTIVITY_KIND.FORWARD, authorId, body, { toId: toEmployeeId, toName: target.name });
  return { holderId: toEmployeeId };
}

/** anyone in the chain answers → back to the assignee, status → todo (dispatcher re-fires) */
export async function answerQuestion(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  // the gate reads the waiting_answer CATEGORY (status freedom): the composer
  // routes the send here by category, so a custom waiting status answers too —
  // the seeded-id gate 400'd them forever (#265 r2, same class as addNote's
  // category exclusion)
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: task.status } },
  });
  if (statusRows.find((r) => r.id === task.status)?.category !== CATEGORY.WAITING_ANSWER)
    throw new Error('task is not waiting for an answer');
  const chain = task.questionChain;
  if (!chain.includes(authorId)) throw new Error('only someone in the question chain can answer');
  // a LIVE review round returns to in-review (the round is still open); the
  // assignee's own question returns to todo so the agent resumes with the answer
  const backTo = (await openRoundLive(taskId)) ? IN_REVIEW_STATUS : TODO_STATUS;
  // TERMINAL ARBITRATION mirror (#287, #292 r1): the return flip arbitrates on the
  // status this call read — a won settle keeps its outcome, the late answer refuses.
  const flipped = await db
    .update(tasks)
    .set({
      status: backTo,
      questionChain: [],
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
    .returning({ id: tasks.id });
  if (flipped.length === 0) throw new Error('task state changed during answer — a settle owns the outcome');
  // OBLIGATION CANCEL-AFTER-FLIP (#314, r1 review): the ANSWER obligation is
  // cancelled only AFTER a WON flip. Cancel-before-flip stranded the classic lost
  // race — the refusal threw while the cancellation had already landed: task still
  // waiting_answer, no ANSWER obligation, the question invisible on every
  // needs-my-decision surface with no heal. Reordered, a lost race touches NO
  // obligation rows — the winning writer owns the status AND its obligations (its
  // own teardown cancels/resolves them, #205/#288); a heal on the miss path was
  // reviewed out (r1: an unguarded read→spawn re-opens the strand via settle
  // write-then-cancel and forward races — shared-state guard law). The ms-wide
  // won-flip→cancel window mirrors the settle path's write-then-cancel shape.
  await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER);
  if (backTo === IN_REVIEW_STATUS) {
    // a review-round question was answered — the AI reviewer's turn re-arms
    await dispatchAiReviewTurns(taskId);
  } else if (await openRoundLive(taskId)) {
    // HOLD-WINDOW REPAIR (#288 r5): the verdict hold's revert can land between our
    // openRoundLive read and this flip — the round is LIVE again while we returned
    // the task to todo (nothing re-fires a ready-status round). Guarded restore to
    // in-review + the reviewer re-fire.
    const cats = await db.query.taskStatuses.findMany({ columns: { id: true, category: true } });
    const readyIds = cats.filter((c) => c.category === CATEGORY.READY).map((c) => c.id);
    const resumed = await db
      .update(tasks)
      .set({ status: IN_REVIEW_STATUS, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), inArray(tasks.status, readyIds)))
      .returning({ id: tasks.id });
    if (resumed.length > 0) {
      await dispatchAiReviewTurns(taskId);
      await logActivity(
        taskId,
        ACTIVITY_KIND.STATUS,
        null,
        'review round resumed — the answer landed while a verdict was being held; the reviewer re-fires now',
        { reviewResumed: true },
      );
    } else {
      // the repair flip lost (the task moved again mid-window — e.g. the dispatcher
      // claimed it to doing): the owner owns it now — say so, owner unblock to
      // in-review re-fires the held reviewer once the RUN LOCK lifts
      await logActivity(
        taskId,
        ACTIVITY_KIND.STATUS,
        null,
        'review round resumed — the answer landed while a verdict was held; the task moved again, owner unblock to in-review re-fires the held reviewer',
        { reviewResumed: true },
      );
    }
  }
  await logActivity(taskId, OBLIGATION_ROLE.ANSWER, authorId, body, {});
  await refreshParentGating(taskId);
  return { ok: true };
}
/** a plain conversation note: thread-only, no state change (relay law 2026-10-26) */
export async function addNote(
  taskId: string,
  authorId: string,
  body: string,
): Promise<{ steered: boolean; dispatched?: true }> {
  const task = await getTask(taskId);
  await logActivity(taskId, ACTIVITY_KIND.NOTE, authorId, body, {});
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  // composer law (owner ruling 2026-10-27): a send steers the live agent; a send
  // while stopped always dispatches the run — the note itself stays thread-only.
  // A live run that can't take input still blocks dispatch (never a second task
  // to a running agent)
  const { steerRun } = await import('./runner.service');
  const steerState = await steerRun(taskId, body);
  if (steerState === 'steered' || steerState === 'refused') return { steered: steerState === 'steered' };
  // COMPOSER LAW: the send dispatches every non-terminal, non-in-review task with
  // an AI assignee — the exclusion keys off the status CATEGORY (custom done/
  // cancelled/in-review statuses included), never the seeded ids (#265).
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: task.status } },
  });
  // waiting_answer is RESERVED for the question flow (#288/#314): while waiting,
  // the send IS the answer verb — the composer routes it there and the hint says
  // "Adds the note to the thread". A DIRECT tasks.note call must never flip the
  // status or dispatch: the unguarded todo flip below would stomp the open
  // question and orphan the live ANSWER obligation + questionChain (noteWillDispatch
  // excludes the category too — client/server parity).
  const excluded = [CATEGORY.DONE, CATEGORY.CANCELLED, CATEGORY.IN_REVIEW, CATEGORY.WAITING_ANSWER] as string[];
  // an unresolved status id (dangling legacy row) is dead input like everywhere
  // else the membership rule applies — thread-only, never a dispatch guess
  const statusCat = statusRows.find((r) => r.id === task.status)?.category;
  if (!statusCat || excluded.includes(statusCat)) return { steered: false as const };
  if (!task.assigneeId) return { steered: false as const };
  const ai = await db.query.aiEmployees.findFirst({
    columns: { userId: true },
    where: { userId: { eq: task.assigneeId } },
  });
  if (!ai) return { steered: false as const };
  // TERMINAL ARBITRATION (#400): the dispatch flip arbitrates on the status AND
  // updatedAt stamp this call read — a note in flight across a terminal write must
  // never resurrect the settled task. A lost flip dispatches nothing; the note
  // itself already landed as a thread item above (thread-only, never a state write).
  const flipped = await db
    .update(tasks)
    .set({ status: STATUS.todo, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
    .returning({ id: tasks.id });
  if (flipped.length === 0) return { steered: false as const };
  const { dispatchIfEligible } = await import('./dispatcher.service');
  const { env } = await import('#server/domains/kernel/env');
  // the skip arms (stale state, pending backoff, agent at cap) must not claim
  // 'agent dispatched' — the success copy reports what actually fired (r5)
  const dispatched = await dispatchIfEligible(taskId, env.TANDEM_PUBLIC_URL ?? 'http://localhost:3000');
  return dispatched ? { steered: false as const, dispatched: true as const } : { steered: false as const };
}

export async function submitResult(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  // WORKING-CATEGORY gate (SPEC: submit from "a working status" — the seeded
  // Doing row carries category working; custom working statuses submit too, the
  // old seeded-doing-id-only check 400'd them forever)
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { category: true },
    where: { id: { eq: task.status } },
    orderBy: { position: 'asc' },
  });
  if (statusRows[0]?.category !== CATEGORY.WORKING) throw new Error('only a task in progress can submit');
  if (task.assigneeId !== authorId) throw new Error('only the assignee can submit');
  if (await hasOpenChildren(taskId)) throw new Error('task has open subtasks — they must be done or cancelled first');
  // explicit reviewers only (owner ruling 2026-10-26): the org supervisor is NOT a
  // quality gate — a task with nobody set completes immediately. REVIEWER EXISTENCE
  // (#361): re-check the roster here — an employee deleted AFTER being set would
  // otherwise hit task_reviews.reviewer_id's FK (23503) and wedge the submit with a
  // driver 500. Absent ids drop out of the round; zero survivors completes exactly
  // as if no reviewer were set.
  const roster = task.reviewers;
  const reviewers = await liveReviewers(roster);
  // skipped = distinct stored entries that no longer name a company user (deleted
  // employees, legacy non-uuid junk); case variants of ONE id are the same
  // reviewer, not a skip (UUID-CASE LAW). A reviewer the round-open transaction drops
  // (deleted inside the pre-check→lock window, #364) counts as skipped too. The note is
  // written only AFTER the submit succeeds (#361 r4) — a failed round-open must not
  // leave a thread note claiming reviewers were skipped when nothing changed.
  const distinctRoster = new Set(roster.map((id) => canonicalStoredUuid(id) ?? id.trim().toLowerCase())).size;
  let droppedInRound = 0;
  const noteSkipped = async () => {
    const skipped = distinctRoster - reviewers.length + droppedInRound;
    if (skipped > 0) {
      await logActivity(taskId, ACTIVITY_KIND.NOTE, null, `${skipped} reviewer(s) skipped — not in the company`, {
        skippedReviewers: skipped,
      });
    }
  };
  // ZERO SURVIVORS (#361 r4/r6): no round may outlive the completion — a working task
  // can still carry one (a manual move out of review never tears it down), and a
  // superseded MAX round can hide an older live round. Runs AFTER the won CAS so a lost
  // submit never tears down a round the winner still owns; closes EVERY pending round.
  // The same arm completes a submit whose reviewers ALL vanished inside the round-open
  // transaction (#364): nothing was minted, so there is no round to settle.
  const completeWithoutReviewers = async () => {
    const done = await db
      .update(tasks)
      .set({ status: DONE_STATUS, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
      .returning({ id: tasks.id });
    if (done.length === 0) throw new Error('task state changed during submit — a settle owns the outcome');
    await teardownAllPendingRounds(taskId, 'no live reviewers');
    await noteSkipped();
    await refreshParentGating(taskId);
    return { status: DONE_STATUS };
  };
  // thread law (owner ruling 2026-10-29): the result lives on the run's OWN message
  // (updateRunMessageBody) — the submission must not post a second agent-authored
  // thread row; the activity row stays for the review brief + audit
  await logActivity(taskId, ACTIVITY_KIND.VERDICT, authorId, body, { submitted: true, reviewers }, { thread: false });
  if (reviewers.length > 0) {
    // ROUND + FLIP IN ONE TRANSACTION (#394): the round's rows and obligations commit
    // only together with the in-review flip, so a submit that loses the terminal
    // arbitration mints NOTHING — no rows to withdraw, no obligation to cancel, no round
    // number to re-point, and no reviewer turn in flight for a round that never opened.
    const opened = await openReviewRound(taskId, reviewers, body, {
      status: task.status,
      updatedAt: task.updatedAt,
    });
    droppedInRound = opened.dropped.length;
    // every reviewer vanished inside the round-open transaction (#364): nothing was
    // minted and no flip landed — complete exactly like zero survivors.
    if (opened.opened === 0) return await completeWithoutReviewers();
    // TERMINAL ARBITRATION mirror (#287, #292 r1): a won abandon/settle between the gate
    // read and the flip owns the outcome; this call refuses with the error surfaced and
    // wrote nothing at all.
    // NO park-disarm here (#292 r3): the loser's own parkRound can never land on a
    // working-category task (the r1 rethrow owns that window), so a disarm would only
    // ever strip a CONCURRENT round's legitimate park recovery state — the re-arm scan
    // and the park-origin restore both depend on those columns.
    if (!opened.flipped) throw new Error('task state changed during submit — a settle owns the outcome');
    // best-effort BETWEEN the commit and the dispatch (#394 r6): a throw here must not
    // skip the reviewer turn — the round is already the outcome, and a live round with a
    // PENDING row and no run in flight has no automatic recovery. Each step is isolated
    // and logged; the dispatch below always runs.
    try {
      await noteSkipped();
    } catch (e) {
      log.warn(`submit: skip note failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    try {
      await refreshParentGating(taskId);
    } catch (e) {
      log.warn(`submit: parent re-gate failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    // the reviewer turn is dispatched only AFTER the round committed and the parents
    // re-gated (#394): a park raised here must stick — dispatching before the gating
    // write let its restore arm immediately unblock the fresh park, burning two rungs of
    // the rearm ladder per failed outage. Fault-isolated: the round is already the
    // outcome, so a dispatch failure never turns a landed submit into an error. A throw
    // that did NOT come from the per-row mint attempt (a setup read, or the park itself)
    // parks here so the round is never left live with no run and no marker (#397 covers
    // the process-crash flavour of that window).
    try {
      await dispatchAiReviewTurns(taskId, body);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn(`round opened but the reviewer turn failed for task ${taskId}: ${reason}`);
      await parkRound(taskId, `review turn dispatch failed — ${reason}`, { rearmable: true }).catch(() => {});
    }
    // #365: a reviewer deleted inside the round-open window leaves a void row on the
    // round this submit just flipped in-review — settle it now (the settle is a no-op
    // while a live voter exists, so a normal submit pays only a few reads). The submit
    // already WON its flip: a heal failure must never 500 a submit that landed — the
    // boot heal is the backstop.
    try {
      await settleExtinguishedRound(taskId);
    } catch (e) {
      log.warn(`submit: extinguished-round settle failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
    return { status: IN_REVIEW_STATUS };
  }
  return await completeWithoutReviewers();
}

/** reviewer approves — writes the task_reviews row via recordVerdict */
export async function approveReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if ((await statusCategoryOf(task.status)) !== CATEGORY.IN_REVIEW) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.APPROVED, body, 'human');
  await refreshParentGating(taskId);
  return { ok: true };
}

/** reviewer rejects — HUMAN-only terminal verdict: task cancelled */
export async function rejectReview(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if ((await statusCategoryOf(task.status)) !== CATEGORY.IN_REVIEW) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.REJECTED, body, 'human');
  await refreshParentGating(taskId);
  return { ok: true };
}

/** reviewer requests changes — task back to the assignee (ready), note rides the next brief */
export async function requestChanges(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  if ((await statusCategoryOf(task.status)) !== CATEGORY.IN_REVIEW) throw new Error('task is not in review');
  await recordVerdict(taskId, authorId, REVIEW_STATUS.CHANGE_REQUESTED, body, 'human');
  await refreshParentGating(taskId);
  return { ok: true };
}

/** abandon = cancel, one terminal (SPEC: the Abandon verb renders in working
 *  states — review rounds abandon the round path; tasks still in the work
 *  states cancel directly, owner or assignee only, never over a live run
 *  (RUN LOCK — the runner owns the task while it runs, parity with remove)). */
export async function abandonTask(taskId: string, authorId: string, body: string) {
  const task = await getTask(taskId);
  const isOwner = task.ownerId === authorId || task.createdBy === authorId;
  const isReviewer = task.reviewers.includes(authorId);
  // CATEGORY-GATE LAW (#336): the review-abandon path and the work-cancel path
  // branch on the status CATEGORY — a custom in-review status abandons exactly
  // like the seeded one instead of falling into the work branch and refusing.
  const abandonCategory = await statusCategoryOf(task.status);
  const fromReview = abandonCategory === CATEGORY.IN_REVIEW;
  if (fromReview) {
    if (!isReviewer && !isOwner) throw new Error('only a reviewer or the owner can abandon');
  } else {
    if (
      abandonCategory !== CATEGORY.READY &&
      abandonCategory !== CATEGORY.WORKING &&
      abandonCategory !== CATEGORY.PAUSED &&
      abandonCategory !== CATEGORY.BACKLOG
    ) {
      throw new Error('task is not in a cancellable state');
    }
    if (!isOwner && task.assigneeId !== authorId)
      throw new Error('only the owner or the assignee can cancel a working task');
    const running = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
      .where(and(eq(taskMessages.taskId, taskId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    if (running.length > 0) throw new Error('cancel the running run first');
  }
  // TERMINAL ARBITRATION (#287) + ABANDON ORDERING (#397): the cancel write is the
  // arbitration AND the transaction's FIRST write — a concurrent verdict settle (-> done)
  // or submit flip (-> in-review) that won the task between the read and this write owns
  // the outcome, and the loser writes NOTHING: no obligation cancel, no round teardown,
  // no note. The teardown rides the SAME transaction, so it can neither outlive a lost
  // CAS (the old order superseded the winner's round and cancelled its obligations before
  // refusing) nor leave a cancelled task carrying a pending row when a write fails.
  // A won cancel makes the LIFECYCLE writers lose by construction: a submit needs a
  // working category and the verdict flip refuses terminal-category statuses. The
  // note/ask status flips arbitrate too since #400 — no lifecycle writer can move a
  // task after a terminal write won it.
  const teardown = await db.transaction(async (tx) => {
    const d = asDb(tx);
    const cancelled = await d
      .update(tasks)
      .set({ status: CANCELLED_STATUS, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status), eq(tasks.updatedAt, task.updatedAt)))
      .returning({ id: tasks.id });
    if (cancelled.length === 0) return { won: false as const };
    // TERMINAL TEARDOWN (#361 r6 / #397 r2): a cancelled task never keeps a pending review
    // row or a pending obligation — EVERY round tears down, not just the MAX one (a manual
    // move out of review legally leaves an older round open, and the work branch can cancel
    // a task that still carries a live round), and BOTH roles cancel on every branch.
    // Change events are deferred to the post-commit note (#397 r1): a redis publish must
    // never gate the held tasks row lock, and a rollback must never announce erased rows.
    await cancelObligations(taskId, OBLIGATION_ROLE.ANSWER, tx);
    await cancelAllObligations(taskId, OBLIGATION_ROLE.APPROVAL, tx);
    await teardownAllPendingRounds(taskId, 'cancelled', tx, { publish: false });
    return { won: true as const };
  });
  if (!teardown.won) throw new Error('task state changed during cancel — a settle owns the outcome');
  // abandoned == cancelled (one terminal, no fake distinction)
  await logActivity(taskId, ACTIVITY_KIND.VERDICT, authorId, body || 'cancelled', { abandon: true });
  await refreshParentGating(taskId);
  return { ok: true };
}

/** activity feed for one task, oldest first — the thread carries the rows
 * (task_activity retired 2026-10-30): kind + meta live in the message's activity
 * payload extension; run-linked rows are runs, not activity */
export async function listActivity(taskId: string) {
  const rows = await db.query.taskMessages.findMany({
    columns: { id: true, body: true, authorId: true, createdAt: true },
    where: { taskId },
    orderBy: { createdAt: 'asc', id: 'asc' },
    with: { activityExt: { columns: { payload: true } }, run: { columns: { id: true } } },
  });
  return rows
    .filter((m) => !m.run)
    .map((m) => {
      const payload = normalizeActivityPayload(m.activityExt?.payload) ?? {};
      const { kind, ...meta } = payload;
      return {
        id: m.id,
        taskId,
        kind: typeof kind === 'string' ? kind : 'note',
        authorId: m.authorId,
        body: m.body,
        meta,
        createdAt: m.createdAt,
      };
    });
}
