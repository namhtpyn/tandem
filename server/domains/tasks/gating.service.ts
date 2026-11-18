// Parent gating: a parent is blocked while ANY child is open and unblocks when ALL
// children are terminal (done or a cancelled-category status; abandoned was merged into cancelled).
// The flip is DERIVED state — no human action, no drift (user law, 2026-10-15):
//   - children spawn → parent flips to 'blocked' (pre_block_status remembers the old one)
//   - last child lands terminal → parent restores pre_block_status (or 'todo')
//   - recursive by construction: a child isn't complete while ITS children are open,
//     because the same rule keeps that child non-terminal until its own gate lifts.
import { consola } from 'consola';
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';

import { ACTIVITY_KIND, CATEGORY, CHANGE_ACTION, CHANGE_RESOURCE } from '#shared/enums';
import { STATUS } from '#shared/status';
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskStatuses } from '../../db/schema';
import { publishChange } from '../kernel/change-bus';
import { AfterCommitQueue } from './after-commit';
import {
  hasLiveReviewRow,
  hasVerdictAfter,
  isRestoreStrand,
  newestBlockHomeRecord,
  newestParkHomeRecord,
} from './review-strand';
import {
  logActivity as publishActivity,
  dispatchAiReviewTurns,
  openRoundLive,
  settleExtinguishedRound,
  PARK_REARM_LADDER_MS,
} from './review.service';

export const BLOCKED_STATUS = STATUS.blocked;

/** #365: a restore that lands in-review replays a LIVE round's parked turn or settles
 *  an extinguished one (its reviewer was deleted while the task was blocked) — never
 *  leave a round nothing can ever decide. A non-parked restore to in-review replays
 *  nothing (#202 parity: only a park carries a parked turn). LADDER-OWNED ONLY (#419):
 *  an automatic restore re-fires only a park that still schedules a rung
 *  (park_rearm_after set) — a DECISION-class park (a stopped turn, an exhausted
 *  escalation, a verdict-less round after its retry) and a FINAL park (past the ladder)
 *  are the round's own stop and wait for the owner, never for a child to land. */
async function resumeRestoredRound(taskId: string, resumeTurn: boolean, restoreCategory: string | undefined) {
  // #369: a restore into the QUESTION flow re-runs the answer arm — a holder removed
  // while the task was BLOCKED left its NULL-holder row as the machine signature (the
  // arm never cancels it on a blocked task), and no other path would return it.
  if (restoreCategory === CATEGORY.WAITING_ANSWER) {
    try {
      const { hasOrphanAnswerSignature, returnRemovedAnswerHolderTask } = await import('./review.service');
      // ONLY the machine signature: a legal manual move into a waiting-answer status
      // carries no pending row and must never be flipped out of its flow (#369)
      if (await hasOrphanAnswerSignature(taskId)) await returnRemovedAnswerHolderTask(taskId);
    } catch (e) {
      log.warn(`gating: answer-holder restore heal failed for task ${taskId}:`, e instanceof Error ? e.message : e);
    }
  }
  if (!resumeTurn && restoreCategory !== CATEGORY.IN_REVIEW) return;
  try {
    const roundLive = await openRoundLive(taskId);
    if (resumeTurn && roundLive) await dispatchAiReviewTurns(taskId);
    else if (!roundLive && restoreCategory === CATEGORY.IN_REVIEW) await settleExtinguishedRound(taskId);
  } catch (e) {
    // FAULT ISOLATION (#365 r6): this runs inside refreshParentGating, which every task
    // write awaits — a heal failure must never 500 a write that already landed. The
    // next boot/removal trigger retries the settle (the void row is still there).
    log.warn(`gating: restore-resume failed for task ${taskId}:`, e instanceof Error ? e.message : e);
  }
}

const log = consola.withTag('tandem');

// activity rows are notification state, not gating state — they ride the pool db even
// mid-tx — EXCEPT the FLOW RECORDS the probe orders verdicts against (#466): the
// auto-block note is read back as the block's own timestamp, so the block arm hands it
// the SAME executor as its status write and defers the change events to post-commit.
async function logActivity(
  taskId: string,
  body: string,
  meta: Record<string, unknown> = {},
  ex: DbExecutor = db,
  opts: { publish?: boolean } = {},
) {
  await publishActivity(taskId, ACTIVITY_KIND.STATUS, null, body, meta, ex, opts);
}

/** status ids whose category is terminal (done | cancelled) */
export async function terminalStatusIds(ex: DbExecutor = db) {
  // seeded categories are lowercase ('done' | 'cancelled'); OBLIGATION_STATUS is a different key space
  const rows = await asDb(ex)
    .select({ id: taskStatuses.id, category: taskStatuses.category })
    .from(taskStatuses)
    .where(inArray(taskStatuses.category, ['done', 'cancelled']));
  return new Set(rows.map((r) => r.id));
}

/** UNBLOCK RESTORE LAW (#88, 2026-10-31): resolve the pre-block restore target before
 * the write — this write bypasses the setStatus membership guard, so an unknown/malformed
 * id would re-create a dangling tasks.status (the #62 class): it falls back to to-do.
 * A working-category target also restores to to-do: a working status must be backed by
 * a live run and the dispatcher scans ready-category only — restore-to-doing dead-ended
 * the task (prod 9515f3f8 sat stranded 4+ days after its unblock). */
export function resolveRestoreTarget(restoreId: string, known: ReadonlyMap<string, string>): string {
  const category = known.get(restoreId);
  if (!category || category === 'working') return STATUS.todo;
  return restoreId;
}

/** PARK-ORIGIN RESTORE (#202): a review park's own origin is the restore target — the
 * recorded pre-park status (in-review by construction), resolved against task_statuses.
 * An unknown/malformed id falls back to in-review, NEVER to-do: a to-do restore re-enters
 * the ready-category dispatch scan and bypasses the open review round (the #88 demotion
 * law must not eat a parked round). */
export function resolveParkRestoreTarget(parkFrom: string, known: ReadonlyMap<string, string>): string {
  return known.has(parkFrom) ? parkFrom : STATUS.inReview;
}

async function statusCategoryMap(ex: DbExecutor = db): Promise<Map<string, string>> {
  const rows = await asDb(ex).select({ id: taskStatuses.id, category: taskStatuses.category }).from(taskStatuses);
  return new Map(rows.map((r) => [r.id, r.category]));
}

type GatingRow = {
  id: string;
  status: string;
  preBlockStatus: string | null;
  parkFromStatus: string | null;
  parkRearmAfter: Date | null;
};

/** #479: the post-commit queue lives in its own module so callers and tests share it */
export { AfterCommitQueue } from './after-commit';
export type { AfterCommit } from './after-commit';

/** the unblock arm (#208/#202/#365/#419): restore a row whose children all landed
 *  terminal. A park the LADDER does not own (a decision-class park, or a FINAL park
 *  past the ladder) is the round's own stop while its round is live — it is withheld
 *  for the owner, never dissolved by an automatic restore. Returns 'restored' (the
 *  write landed), 'lost' (a concurrent writer owns the outcome) or 'withheld'. */
async function restoreUnblocked(
  cur: GatingRow,
  ex: DbExecutor,
  afterCommit?: AfterCommitQueue,
): Promise<'restored' | 'lost' | 'withheld'> {
  // PARK-ORIGIN RESTORE (#202): a parked task (park_from_status set) restores its
  // recorded pre-park status even with no pre_block_status — pure parks stranded here
  // forever before. Park origin outranks a stale pre_block_status (a gate that
  // pre-dated the park); a plain gated unblock keeps the #88 restore law.
  const parked = Boolean(cur.parkFromStatus);
  // MACHINE-CLASS ONLY (#419): the automatic restore belongs to the LADDER — only a
  // park with a scheduled rung (park_rearm_after set) is resumed here. A DECISION park
  // and a FINAL (exhausted) park are the round's own stop: the owner resolves them,
  // and dissolving the park here would leave a live round nothing fires.
  const ladderOwns = parked && (cur.parkRearmAfter ?? null) !== null;
  // a decision/final park is the round's OWN stop, extinguished round or not: the owner
  // resolves it (the boot/removal heals refuse a paused task by contract, and the void
  // row survives) — dissolving it here would settle a round the owner deliberately
  // parked, and a live one would be left with nothing to fire it
  if (parked && !ladderOwns) return 'withheld';
  // RESTORE-STRAND EVIDENCE (#500): the three advisory facts (the block record, a live
  // round, a post-record verdict) are read on the POOL before the write. A failure here is
  // logged and never blocks the restore — and never poisons a borrowed caller's
  // transaction (a failed statement ABORTS a Postgres tx; a local try/catch only stops the
  // throw, it cannot undo the abort). The DECISIVE categories are re-read at the flip
  // below, so a status re-key committing inside the walk->flip window is judged against
  // the category the write actually commits against (the block arm's own rule).
  let evidence: {
    originStatusId: string;
    recordedCategory: string | null;
    ghostAtBlock: boolean;
    liveRound: boolean;
    lateVerdict: boolean;
  } | null = null;
  // PARK HALF (#502): the park note's own `homeCategoryAtPark` record is the park origin's
  // recorded category — the block record is the wrong record for a park (its home is
  // `park_from_status`, and the flip clears `pre_block_status`). A pre-floor park note
  // carries no record and leaves the detector silent (declared residual below 2.78.43).
  const evidenceOrigin = parked ? cur.parkFromStatus : cur.preBlockStatus;
  if (evidenceOrigin) {
    try {
      const homeRecord = parked ? await newestParkHomeRecord(cur.id, db) : await newestBlockHomeRecord(cur.id, db);
      if (homeRecord) {
        const liveRound = await hasLiveReviewRow(cur.id, db);
        // report BOTH facts: the strand is an OR, but the record's `lateVerdict` must be
        // true whenever a verdict landed after the block, even beside a live pending row
        const lateVerdict = await hasVerdictAfter(cur.id, homeRecord.at, db);
        evidence = {
          originStatusId: evidenceOrigin,
          recordedCategory: homeRecord.category,
          // #503: the block record is FLOORED and names NO category — the block committed
          // against a home that already named no task_statuses row (the ghost-task race).
          // Only a block record can carry null (the park record returns null instead).
          ghostAtBlock: homeRecord.category === null,
          liveRound,
          lateVerdict,
        };
      }
    } catch (e) {
      log.warn(`gating: restore-strand detector failed for task ${cur.id}:`, e instanceof Error ? e.message : e);
    }
  }
  // GUARDED GATING WRITE (#208): atomic on the row still being BLOCKED (same pattern
  // as bounceTaskAfterRun) — a category/owner await opens a window a concurrent settle or
  // unblock can win. PARK-AWARE CAS (#419): a park landing in that window writes while the
  // status stays BLOCKED, so the status term alone cannot arbitrate it — the parked branch
  // pins the origin it read, the gated branch requires NO park to have appeared AND still
  // pins ITS origin: the origin is rewrite-able on a blocked row (STATUS-ORIGIN MEMORY
  // LAW, #432, re-homes a home whose status is deleted), and an unpinned restore would
  // write the STALE target it resolved from the pre-rewrite id — a deleted status id (a
  // ghost task) or the #88 to-do demotion.
  // ATOMIC RECORD (#466/#500): on the own-pool path the resolve + flip + flow record
  // commit in ONE transaction (the block arm's pattern) — a crash can never leave a landed
  // restore without its note, and a strand without its detector record. A borrowed caller
  // transaction is RIDDEN, never nested; its events wait for that commit (#397).
  type RestoreOutcome = { landed: boolean; restore: string; restoreCategory: string | undefined };
  const flipAndRecord = async (exec: DbExecutor): Promise<RestoreOutcome> => {
    const known = await statusCategoryMap(exec);
    const restore = parked
      ? resolveParkRestoreTarget(nonNull(cur.parkFromStatus), known)
      : resolveRestoreTarget(nonNull(cur.preBlockStatus), known);
    const restoreCategory = known.get(restore);
    // the detector's decision uses the flip-time map (the block arm's rule: the record
    // carries the category the write actually committed against)
    let strand: {
      recordedCategory: string | null;
      ghostAtBlock: boolean;
      homeCategory: string | null;
      landingCategory: string;
      liveRound: boolean;
      lateVerdict: boolean;
    } | null = null;
    if (evidence) {
      const homeCategory = known.get(evidence.originStatusId);
      const landingCategory = known.get(restore);
      if (
        isRestoreStrand({
          recordedCategory: evidence.recordedCategory,
          ghostAtBlock: evidence.ghostAtBlock,
          homeCategory,
          landingCategory,
          liveRound: evidence.liveRound,
          postRecordVerdict: evidence.lateVerdict,
        })
      ) {
        strand = {
          recordedCategory: evidence.recordedCategory,
          ghostAtBlock: evidence.ghostAtBlock,
          homeCategory: homeCategory ?? null,
          landingCategory: nonNull(landingCategory),
          liveRound: evidence.liveRound,
          lateVerdict: evidence.lateVerdict,
        };
      }
    }
    const rows = await asDb(exec)
      .update(tasks)
      .set({ status: restore, preBlockStatus: null, parkFromStatus: null, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, cur.id),
          eq(tasks.status, BLOCKED_STATUS),
          parked
            ? eq(tasks.parkFromStatus, nonNull(cur.parkFromStatus))
            : and(isNull(tasks.parkFromStatus), eq(tasks.preBlockStatus, nonNull(cur.preBlockStatus))),
        ),
      )
      .returning({ id: tasks.id });
    if (rows.length === 0) return { landed: false, restore, restoreCategory };
    await logActivity(
      cur.id,
      strand
        ? strand.ghostAtBlock
          ? `unblocked: all subtasks terminal → ${restore} — REVIEW STRAND (ghost-at-block): the block recorded no home category (its home already named no status); restoring to ${strand.landingCategory} strands the ${strand.liveRound ? 'live' : 'decided'} review round`
          : `unblocked: all subtasks terminal → ${restore} — REVIEW STRAND: the recorded home category ${strand.recordedCategory} ${strand.homeCategory === null ? 'no longer resolves' : `was re-keyed to ${strand.homeCategory}`}; restoring to ${strand.landingCategory} strands the ${strand.liveRound ? 'live' : 'decided'} review round`
        : `unblocked: all subtasks terminal → ${restore}`,
      {
        autoUnblocked: true,
        restored: restore,
        ...(parked ? { parkResumed: true } : {}),
        ...(strand
          ? {
              reviewStrand: true,
              recordedCategory: strand.recordedCategory,
              ghostAtBlock: strand.ghostAtBlock,
              homeCategory: strand.homeCategory,
              landingCategory: strand.landingCategory,
              liveRound: strand.liveRound,
              lateVerdict: strand.lateVerdict,
            }
          : {}),
      },
      exec,
      { publish: false },
    );
    return { landed: true, restore, restoreCategory };
  };
  let outcome: RestoreOutcome;
  if (ex === db) {
    outcome = await db.transaction((tx) => flipAndRecord(tx));
    if (outcome.landed) {
      await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
      await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    }
  } else {
    outcome = await flipAndRecord(ex);
  }
  if (!outcome.landed) return 'lost';
  // unblock-resume parity (#202) + #365 + #419: replay a restored LADDER park's turn,
  // settle a restore that lands in-review with no live voter (leaf helper).
  // BORROWED-RESTORE DEFERRAL (#479): these side effects are NOT transactional, so on a
  // borrowed executor they must not fire before the caller commits — a rollback would
  // leave a settle/dispatch no restore row backs. Classification is keyed on the
  // EXECUTOR, never on the collector's presence: an own-pool call that happens to pass a
  // collector still keeps the immediate order (its guarded write already committed).
  const resume = () => resumeRestoredRound(cur.id, ladderOwns, outcome.restoreCategory);
  if (ex === db) await resume();
  else {
    // the entry guard already refused a queue-less borrow; kept explicit so the
    // deferral can never silently fall back to running pre-commit
    if (!afterCommit) throw new Error('restoreUnblocked: borrowed restore without a collector (#479)');
    afterCommit.defer(resume);
  }
  return 'restored';
}

/**
 * recompute the auto-block for every ancestor of this task. Call after ANY status
 * change on a task (its own transition may release or tighten its parents' gates).
 *
 * BORROWED-RESTORE DEFERRAL (#479): a caller may pass its open transaction as `ex` —
 * it then MUST also pass the `afterCommit` collector it will drain once the transaction
 * commits. An unblock restore hands its non-transactional resume work back through it
 * instead of running pre-commit, so a rollback can never leave a settle or a dispatch
 * behind. Own-pool calls (no `ex`) keep the immediate order; a borrowed call without a
 * collector is a contract error, refused before any read or write. The collector is a
 * caller obligation: drain every closure after commit (confirmProposal does).
 */
export async function refreshParentGating(taskId: string, ex: DbExecutor = db, afterCommit?: AfterCommitQueue) {
  if (ex !== db && !afterCommit) {
    throw new Error('refreshParentGating: a borrowed executor requires an afterCommit collector (#479)');
  }
  const d = asDb(ex);
  const terminal = await terminalStatusIds(ex);
  // gate the task itself, then every ancestor; guard against cycles defensively
  const seen = new Set<string>();
  let cur = await d.query.tasks.findFirst({
    columns: {
      id: true,
      status: true,
      preBlockStatus: true,
      parkFromStatus: true,
      parkRearmAfter: true,
      parentTaskId: true,
    },
    where: { id: { eq: taskId } },
  });
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const children = await d.query.tasks.findMany({
      columns: { status: true },
      where: { parentTaskId: { eq: cur.id } },
      orderBy: { createdAt: 'asc' },
    });
    const open = children.filter((c) => !terminal.has(c.status)).length;
    if (open > 0 && cur.status !== BLOCKED_STATUS) {
      // the home this block records is the task's OWN current status (#419). An
      // existing pre_block_status here is stale by construction — the restore clears
      // both origins and a flip out of a block writes only the status, so on a
      // non-BLOCKED row any surviving origin is a leftover; promoting it would restore
      // the task to a category it no longer belongs to. (The arm never fires on BLOCKED,
      // so the recorded home can never be BLOCKED itself.)
      const pre = cur.status;
      const gateId = cur.id;
      // GUARDED GATING WRITE (#208): one conditional flip — a row that flipped BLOCKED
      // between the read and this write (a park, another gate) wins; zero rows = the
      // concurrent writer owns the outcome and its own thread note
      // BLOCK-PARK RECORD FLOOR (#466): the flip and its flow record commit in ONE
      // transaction — the probe's paused-row arms order the round's verdict against
      // this note instead of the maskable tasks.updated_at, so a landed block must
      // never exist without it. A caller's open transaction is ridden, never nested;
      // a pool call opens its own. Change events publish only after commit.
      const flipAndRecord = async (exec: DbExecutor) => {
        const rows = await asDb(exec)
          .update(tasks)
          // PARK-MEMORY SUPERSESSION (#419): the gate records the round home in
          // pre_block_status and CLEARS any stale park origin — a parked row can never
          // look like a gated one (both machine origins on one row make the park
          // discriminator (park_from_status IS NULL) lie for every reader)
          .set({ status: BLOCKED_STATUS, preBlockStatus: pre, parkFromStatus: null, updatedAt: new Date() })
          .where(and(eq(tasks.id, gateId), ne(tasks.status, BLOCKED_STATUS)))
          .returning({ id: tasks.id });
        if (rows.length === 0) return false;
        // HOME-CATEGORY RECORD (#491): the note carries the home's CATEGORY from the
        // block's own transaction — the probe's RE-KEYED-HOME arm reads it to tell the
        // legal #423 settle-then-reblock (recorded category already terminal) from a home
        // re-keyed terminal while the task sat blocked (recorded non-terminal, resolves
        // terminal now, its pending turn superseded by the owner-settled teardown, an
        // all-older round). `pre` is the walk's read; the category is re-read HERE, so a
        // re-key landing between the walk and the flip records the category the block
        // actually committed against. A home naming no status row records null — that
        // dangling shape belongs to the ORPHAN-HOME arm, never this field.
        const homeCategory = (await statusCategoryMap(exec)).get(pre) ?? null;
        await logActivity(
          gateId,
          `auto-blocked: ${open} subtask(s) open`,
          { autoBlocked: true, open, homeCategory },
          exec,
          { publish: false },
        );
        return true;
      };
      if (ex === db) {
        // own transaction: the events fire AFTER its commit (#397)
        if (await db.transaction(flipAndRecord)) {
          await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
          await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
        }
      } else {
        // RIDING a caller's open transaction: the flip + record join it, but events must
        // wait for ITS commit — an event must never announce rows a rollback erases, and
        // a publish must never run under a held row lock (#397). The caller publishes its
        // own change set post-commit (confirmProposal does).
        await flipAndRecord(ex);
      }
    } else if (open === 0 && cur.status === BLOCKED_STATUS && (cur.preBlockStatus || cur.parkFromStatus)) {
      // the unblock arm (leaf helper): a 'lost' CAS means a concurrent writer owns the
      // outcome and the walk stops (the winner re-gates itself). A WITHHELD park is not
      // a lost race — the row is still blocked and counts in its parent's open set, so
      // the walk continues and the ancestors re-derive (#419).
      if ((await restoreUnblocked(cur, ex, afterCommit)) === 'lost') break;
    }
    if (!cur.parentTaskId) break;
    cur = await d.query.tasks.findFirst({
      columns: {
        id: true,
        status: true,
        preBlockStatus: true,
        parkFromStatus: true,
        parkRearmAfter: true,
        parentTaskId: true,
      },
      where: { id: { eq: cur.parentTaskId } },
    });
  }
}

/** does this task have any open children? (review gate: can't submit while true) */
export async function hasOpenChildren(taskId: string) {
  const children = await db.query.tasks.findMany({
    columns: { status: true },
    where: { parentTaskId: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  if (children.length === 0) return false;
  const terminal = await terminalStatusIds();
  return children.some((c) => !terminal.has(c.status));
}

// PARK-REARM scan (#211): a parked review round whose infra-class re-arm ladder is due
// re-runs the unblock arm — the one-shot arm fired into an outage once (#211's frozen
// shape), so the tick revisits it. Never rejects (tick-isolation contract); best-effort
// like the sweeps.
export const REARM_SCAN_LIMIT = 5;

export async function rearmParkedRounds(): Promise<number> {
  try {
    return await rearmParkedRoundsInner();
  } catch (e) {
    log.warn('park re-arm scan failed:', e instanceof Error ? e.message : e);
    return 0; // best-effort scan: a failed read just means try again next tick
  }
}

async function rearmParkedRoundsInner(): Promise<number> {
  // the WHERE carries the whole shape in SQL (bounding law): BLOCKED + a scheduled
  // re-arm that is due; decision parks (after null) and exhausted ladders (final
  // park, after null) never match. Partial-index-backed + LIMIT-bounded.
  const due = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(eq(tasks.status, BLOCKED_STATUS), isNotNull(tasks.parkRearmAfter), lte(tasks.parkRearmAfter, new Date())),
    )
    .orderBy(asc(tasks.parkRearmAfter))
    .limit(REARM_SCAN_LIMIT);
  if (due.length === 0) return 0;
  const terminal = await terminalStatusIds();
  let rearmed = 0;
  for (const row of due) {
    // arm precondition first: zero open children. A parked parent whose children are
    // still open re-fires from the child's settle path — defer one ladder step instead
    // of hot-revisiting every tick (no attempt burned: the ladder only advances on a
    // park write).
    const kids = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.parentTaskId, row.id));
    if (kids.some((k) => !terminal.has(k.status))) {
      await db
        .update(tasks)
        .set({ parkRearmAfter: new Date(Date.now() + PARK_REARM_LADDER_MS[0]) })
        .where(and(eq(tasks.id, row.id), eq(tasks.status, BLOCKED_STATUS)));
      continue;
    }
    // the unblock arm owns the flip: guarded restore + re-dispatch of the parked
    // reviewer's turn — the exact one-shot path, revisited
    await refreshParentGating(row.id);
    const after = await db.query.tasks.findFirst({
      columns: { status: true },
      where: { id: { eq: row.id } },
    });
    if (after && after.status !== BLOCKED_STATUS) rearmed += 1;
  }
  if (rearmed > 0) log.info(`park re-arm scan: ${rearmed} parked round(s) re-armed`);
  return rearmed;
}
