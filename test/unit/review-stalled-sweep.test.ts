// STALLED-REVIEW SWEEP (#397): a round that committed but never dispatched its
// reviewer turn (the crash window #394's re-ordering opened between the round-open
// transaction and the turn) leaves an in-review task with a PENDING AI reviewer row,
// no run in flight and no park marker. The dispatcher tick's sweep re-fires it.
//
// Pins, in order of strength:
//  1. the pure decision — every near-miss shape must NOT refire (round moved on, live
//     run, reviewer already dispatched this round) and the crash shape must;
//  2. the scan carries the shape in SQL (in_review category + PENDING + live AI
//     reviewer + grace cutoff), LIMIT-bounded, oldest-first;
//  3. the tick runs it with `void` (a slow sweep must never stall the dispatcher);
//  4. the wiring: a crash-shaped candidate produces exactly one review dispatch, and a
//     live run suppresses it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_KIND, REVIEW_STATUS, RUN_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  scan: [] as Array<{ taskId: string; round: number; reviewerId: string; createdAt: Date }>,
  scanThrows: false,
  round: 1,
  liveRun: false,
  /** queued answers for the per-candidate reviewer-run read (one per probe) */
  startedAtQueue: [] as Array<Date | null>,
  reviewRows: [] as Array<Record<string, unknown>>,
  taskStatus: 'st-in-review',
  statusRows: [{ id: 'st-in-review', category: 'in_review' }] as Array<{ id: string; category: string }>,
  resultBody: 'the submitted result',
  dispatched: [] as Array<{ taskId: string; opts?: { reviewBy?: string } }>,
  aiIds: [] as string[],
  published: 0,
  insertThrows: false,
}));

const REV = '00000000-0000-7000-8000-00000000a001';
const TASK = '00000000-0000-7000-8000-00000000b001';
const ROW_MINTED = new Date('2026-11-10T08:00:00Z');

vi.mock('../../server/db/index', async () => {
  /** one universal thenable builder: every chain method returns itself, awaiting it
   *  resolves the result set keyed by the SELECT projection this query was built with */
  const resolve = (projection: Record<string, unknown> | undefined, fullRow: boolean) => {
    if (fullRow) return h.reviewRows;
    const keys = projection ? Object.keys(projection) : [];
    if (keys.includes('reviewerId')) {
      if (h.scanThrows) return new Error('scan exploded');
      return h.scan;
    }
    if (keys.includes('resultBody')) return [{ resultBody: h.resultBody }];
    if (keys.includes('startedAt')) {
      const next = h.startedAtQueue.shift() ?? null;
      return next ? [{ startedAt: next }] : [];
    }
    if (keys.includes('id')) return h.liveRun ? [{ id: 'run-live' }] : [];
    if (keys.includes('round')) return [{ round: h.round }];
    if (keys.includes('status')) return [{ status: h.taskStatus }];
    return [];
  };
  const builder = (projection?: Record<string, unknown>) => {
    const rows = resolve(projection, projection === undefined);
    const settle = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      rows instanceof Error ? Promise.reject(rows).then(onF, onR) : Promise.resolve(rows).then(onF, onR);
    const self: Record<string, unknown> = {};
    const chain = () => self;
    self.from = chain;
    self.innerJoin = chain;
    self.where = chain;
    self.orderBy = chain;
    self.limit = async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    };
    self.then = settle;
    self.catch = (onR: (e: unknown) => unknown) => settle(undefined, onR);
    return self;
  };
  const db = {
    select: (projection?: Record<string, unknown>) => builder(projection),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [], then: async () => [] }) }) }),
    insert: () => ({
      values: () => {
        if (h.insertThrows) throw new Error('thread insert failed');
        return {
          returning: async () => [{ id: 'msg-1' }],
          then: (f?: (v: unknown) => unknown) => Promise.resolve([{ id: 'msg-1' }]).then(f),
        };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    query: {
      aiEmployees: { findMany: async () => h.aiIds.map((userId) => ({ userId })) },
      taskStatuses: { findMany: async () => h.statusRows },
      tasks: { findFirst: async () => null },
    },
  };
  return { asDb: (x: unknown) => x, db };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => void h.published++ };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (taskId: string, _url: string, opts?: { reviewBy?: string }) => {
      h.dispatched.push({ taskId, opts });
      return { runId: 'run-1' };
    },
  };
});

import { startDispatcher } from '../../server/domains/tasks/dispatcher.service';
import {
  STALLED_REVIEW_GRACE_MS,
  dispatchAiReviewTurns,
  logActivity,
  stalledReviewRefire,
  stalledReviewScan,
  sweepStalledReviewTurns,
} from '../../server/domains/tasks/review.service';
import { mockDb } from './helpers/mock-db';

beforeEach(() => {
  h.scan = [{ taskId: TASK, round: 1, reviewerId: REV, createdAt: ROW_MINTED }];
  h.scanThrows = false;
  h.round = 1;
  h.liveRun = false;
  h.startedAtQueue = [];
  h.reviewRows = [
    { id: 'row-1', taskId: TASK, reviewerId: REV, round: 1, status: REVIEW_STATUS.PENDING, createdAt: ROW_MINTED },
  ];
  h.taskStatus = 'st-in-review';
  h.statusRows = [{ id: 'st-in-review', category: 'in_review' }];
  h.resultBody = 'the submitted result';
  h.dispatched = [];
  h.aiIds = [REV];
  h.published = 0;
  h.insertThrows = false;
});

describe('stalledReviewRefire (#397 pure decision)', () => {
  const candidate = { taskId: TASK, round: 2, reviewerId: REV, createdAt: ROW_MINTED };

  it('fires the crash shape: current round, no live run, reviewer never dispatched', () => {
    expect(stalledReviewRefire(candidate, { round: 2, liveRun: false, reviewerRunSince: null, inReview: true })).toBe(
      true,
    );
  });

  it('never re-fires a task that left in-review (manual move / park while scanning)', () => {
    expect(stalledReviewRefire(candidate, { round: 2, liveRun: false, reviewerRunSince: null, inReview: false })).toBe(
      false,
    );
  });

  it('never re-fires a superseded round', () => {
    expect(stalledReviewRefire(candidate, { round: 3, liveRun: false, reviewerRunSince: null, inReview: true })).toBe(
      false,
    );
  });

  it('never re-fires over a live turn (the run row owns the round)', () => {
    expect(stalledReviewRefire(candidate, { round: 2, liveRun: true, reviewerRunSince: null, inReview: true })).toBe(
      false,
    );
  });

  it('never re-fires a reviewer that already had a turn this round (the correction/park law owns it)', () => {
    expect(
      stalledReviewRefire(candidate, {
        round: 2,
        liveRun: false,
        reviewerRunSince: new Date(ROW_MINTED.getTime() + 1),
        inReview: true,
      }),
    ).toBe(false);
  });
});

describe('stalledReviewScan shape (#397)', () => {
  const cutoff = new Date('2026-11-10T08:01:00Z');

  it('carries the shape in SQL: in_review category + PENDING + live AI reviewer + grace cutoff', () => {
    const { sql, params } = stalledReviewScan(mockDb(), cutoff).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('from "task_reviews"');
    expect(flat).toContain('inner join "tasks"');
    expect(flat).toContain('inner join "task_statuses"');
    // the live-AI tie: task_reviews.reviewer_id = ai_employees.user_id (an inner join
    // means a deleted/void row and a HUMAN reviewer never enter the scan)
    expect(flat).toContain('inner join "ai_employees"');
    expect(flat).toContain('"ai_employees"."user_id" = "task_reviews"."reviewer_id"');
    expect(flat).toContain('"task_statuses"."category" =');
    expect(flat).toContain('"task_reviews"."status" =');
    expect(flat).toContain('"task_reviews"."created_at" <');
    expect(params).toContain('in_review');
    expect(params).toContain(REVIEW_STATUS.PENDING);
    expect(params).toContain(cutoff.toISOString());
  });

  it('pushes the CURRENT-round + run discriminators into SQL (#397 r1 starvation fix)', () => {
    const { sql, params } = stalledReviewScan(mockDb(), cutoff).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    // current round: a superseded round's PENDING row (legal after a manual move out of
    // review) must not shadow the live round's row or burn a LIMIT slot
    expect(flat).toContain('"task_reviews"."round" = (select max(r2.round) from task_reviews r2');
    // no live turn on the task, and the reviewer never dispatched in this round
    // (the `tr ` alias form — the lost-settle guard below uses its own aliases)
    expect(flat.match(/not exists \(select 1 from task_runs tr /g)?.length).toBe(2);
    // LOST-SETTLE GUARD (#402 r4): a task carrying a crashed settle is owned by the
    // settle-replay arm — minting the next reviewer's turn here would mask the replay
    expect(flat).toContain('r4.status =');
    expect(flat).toContain('tr4.employee_id = r4.reviewer_id');
    // the guard MIRRORS lostSettleScan (#402 r5): a shape the replay refuses (a reviewer
    // that is also the assignee, a void reviewer row) must never be suppressed here, or
    // the round has no healer at all
    expect(flat).toContain('a4.user_id = r4.reviewer_id');
    expect(flat).toContain('r4.reviewer_id <> "tasks"."assignee_id"');
    // the guard's shape predicates are LOAD-BEARING (deleting any of them suppresses a
    // round the replay refuses): the DONE status, the row→run order, and the newest-run
    // clause each ride the SQL
    expect(flat).toContain('tr4.status =');
    expect(flat).toContain('tr4.started_at >= r4.created_at');
    expect(flat).toContain('(tr5.started_at, tr5.id) > (tr4.started_at, tr4.id)');
    expect(flat).toContain('tr.status =');
    expect(flat).toContain('tr.employee_id = "task_reviews"."reviewer_id"');
    expect(flat).toContain('tr.started_at >= "task_reviews"."created_at"');
    expect(params).toContain(RUN_STATUS.RUNNING);
  });

  it('is LIMIT-bounded and oldest-first (a wedged round can never starve the scan)', () => {
    const { sql } = stalledReviewScan(mockDb(), cutoff).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('order by "task_reviews"."created_at"');
    expect(flat).not.toContain('desc'); // oldest-first, never newest-first
    expect(flat).toContain('limit $');
  });
});

describe('dispatcher tick wiring (#397)', () => {
  it('replays lost settles BEFORE the stalled-round sweep (#402 r5)', () => {
    // a mint for the next reviewer would open a later run for the crashed reviewer and
    // mask the replay forever — the replay must get the tick first
    const src = readFileSync(join(import.meta.dirname, '../../server/domains/tasks/dispatcher.service.ts'), 'utf8');
    const replayAt = src.indexOf('await sweepLostReviewSettles()');
    const stalledAt = src.indexOf('await sweepStalledReviewTurns()');
    expect(replayAt).toBeGreaterThan(-1);
    expect(stalledAt).toBeGreaterThan(-1);
    expect(replayAt).toBeLessThan(stalledAt);
  });

  it('runs the sweep as a bare `void` arm — a slow sweep never stalls the tick', () => {
    const src = readFileSync(join(import.meta.dirname, '../../server/domains/tasks/dispatcher.service.ts'), 'utf8');
    const start = src.indexOf('export function startDispatcher');
    expect(start).toBeGreaterThan(-1);
    const tick = src.slice(start, src.indexOf('return () => clearInterval(timer)', start));
    expect(tick).toContain('void sweepStalledReviewsTick();');
    // and the arm itself is fault-isolated + dynamically imported (no static cycle)
    expect(src).toContain("await import('./review.service')");
  });
});

describe('sweepStalledReviewTurns (#397 behaviour)', () => {
  it('re-fires exactly one review turn for the crash shape', async () => {
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(1);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.taskId).toBe(TASK);
    expect(h.dispatched[0]?.opts?.reviewBy).toBe(REV);
  });

  it('a HUMAN target never suppresses the round’s next AI reviewer (#397 r6)', async () => {
    // escalateReview targets the replacement: when the replacement is a human (card, no
    // turn) the target filter must not swallow the pending AI reviewer's turn
    await dispatchAiReviewTurns(TASK, undefined, { targetReviewerId: 'human-supervisor' });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.opts?.reviewBy).toBe(REV);
  });

  it('a post-mint note failure never turns a minted turn into a failed mint (#397 r5)', async () => {
    h.insertThrows = true; // the thread note throws AFTER the run was created
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(1); // the turn exists — the sweep reports the outcome, not the note
    expect(h.dispatched).toHaveLength(1);
  });

  it('suppresses the re-fire while a run is live on the task', async () => {
    h.liveRun = true;
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it('suppresses the re-fire when the reviewer already had a turn in this round', async () => {
    h.startedAtQueue = [new Date(ROW_MINTED.getTime() + 5_000)];
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it('does not let an exempt row starve the same task’s genuinely stalled row (#397 r1)', async () => {
    // two PENDING AI rows on ONE task, oldest first: A already had a turn this round
    // (exempt), B never did (the crash-window row). The pre-fix sweep claimed the TASK
    // on its first candidate, so B was never examined on any tick.
    const REV_B = '00000000-0000-7000-8000-00000000a002';
    h.scan = [
      { taskId: TASK, round: 1, reviewerId: REV, createdAt: ROW_MINTED },
      { taskId: TASK, round: 1, reviewerId: REV_B, createdAt: new Date(ROW_MINTED.getTime() + 1) },
    ];
    h.startedAtQueue = [new Date(ROW_MINTED.getTime() + 5_000), null];
    // the mint must target the validated row (REV_B) — a plain mint hands the turn to the
    // round's FIRST pending AI row (REV, already dispatched) and leaves REV_B stalled
    h.reviewRows = [
      { id: 'row-a', taskId: TASK, reviewerId: REV, round: 1, status: REVIEW_STATUS.PENDING, createdAt: ROW_MINTED },
      { id: 'row-b', taskId: TASK, reviewerId: REV_B, round: 1, status: REVIEW_STATUS.PENDING, createdAt: ROW_MINTED },
    ];
    h.aiIds = [REV, REV_B];
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(1);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.taskId).toBe(TASK);
    expect(h.dispatched[0]?.opts?.reviewBy).toBe(REV_B);
  });

  it('suppresses the re-fire when the task left in-review between the scan and the mint', async () => {
    h.taskStatus = 'st-todo';
    h.statusRows = [{ id: 'st-todo', category: 'ready' }];
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it('suppresses the re-fire when the candidate belongs to a superseded round', async () => {
    h.scan = [{ taskId: TASK, round: 1, reviewerId: REV, createdAt: ROW_MINTED }];
    h.round = 2;
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it('never throws — a failing scan only costs a tick', async () => {
    h.scanThrows = true; // the SCAN itself rejects (not an empty result)
    await expect(sweepStalledReviewTurns()).resolves.toBe(0);
    expect(h.dispatched).toEqual([]);
    expect(STALLED_REVIEW_GRACE_MS).toBe(60_000);
  });
});

describe('logActivity publish deferral (#397 r1)', () => {
  it('publish:false writes the note but emits NO change event (the tx-safe path)', async () => {
    await logActivity(TASK, ACTIVITY_KIND.STATUS, null, 'round closed', {}, undefined, { publish: false });
    expect(h.published).toBe(0);
    // the default path still publishes both resources (2) — the guard is not a mute
    await logActivity(TASK, ACTIVITY_KIND.STATUS, null, 'round closed', {});
    expect(h.published).toBe(2);
  });
});

describe('dispatcher start/stop still works with the new arm (#397)', () => {
  it('returns a stop function', () => {
    const stop = startDispatcher('http://localhost', 60_000);
    expect(typeof stop).toBe('function');
    stop();
  });
});
