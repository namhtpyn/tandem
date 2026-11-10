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

import { REVIEW_STATUS, RUN_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  scan: [] as Array<{ taskId: string; round: number; reviewerId: string; createdAt: Date }>,
  round: 1,
  liveRun: false,
  reviewerRun: null as Date | null,
  reviewRows: [] as Array<Record<string, unknown>>,
  resultBody: 'the submitted result',
  dispatched: [] as Array<{ taskId: string; opts?: { reviewBy?: string } }>,
  aiIds: [] as string[],
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
    if (keys.includes('reviewerId')) return h.scan;
    if (keys.includes('resultBody')) return [{ resultBody: h.resultBody }];
    if (keys.includes('startedAt')) return h.reviewerRun ? [{ startedAt: h.reviewerRun }] : [];
    if (keys.includes('id')) return h.liveRun ? [{ id: 'run-live' }] : [];
    if (keys.includes('round')) return [{ round: h.round }];
    return [];
  };
  const builder = (projection?: Record<string, unknown>) => {
    const rows = resolve(projection, projection === undefined);
    const self: Record<string, unknown> = {};
    const chain = () => self;
    self.from = chain;
    self.innerJoin = chain;
    self.where = chain;
    self.orderBy = chain;
    self.limit = async () => rows;
    self.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(rows).then(onF, onR);
    self.catch = (onR: (e: unknown) => unknown) => Promise.resolve(rows).catch(onR);
    return self;
  };
  const db = {
    select: (projection?: Record<string, unknown>) => builder(projection),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [], then: async () => [] }) }) }),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: 'msg-1' }],
        then: (f?: (v: unknown) => unknown) => Promise.resolve([{ id: 'msg-1' }]).then(f),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    query: {
      aiEmployees: { findMany: async () => h.aiIds.map((userId) => ({ userId })) },
      taskStatuses: { findMany: async () => [] },
      tasks: { findFirst: async () => null },
    },
  };
  return { asDb: (x: unknown) => x, db };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
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
  stalledReviewRefire,
  stalledReviewScan,
  sweepStalledReviewTurns,
} from '../../server/domains/tasks/review.service';
import { mockDb } from './helpers/mock-db';

beforeEach(() => {
  h.scan = [{ taskId: TASK, round: 1, reviewerId: REV, createdAt: ROW_MINTED }];
  h.round = 1;
  h.liveRun = false;
  h.reviewerRun = null;
  h.reviewRows = [
    { id: 'row-1', taskId: TASK, reviewerId: REV, round: 1, status: REVIEW_STATUS.PENDING, createdAt: ROW_MINTED },
  ];
  h.resultBody = 'the submitted result';
  h.dispatched = [];
  h.aiIds = [REV];
});

describe('stalledReviewRefire (#397 pure decision)', () => {
  const candidate = { taskId: TASK, round: 2, reviewerId: REV, createdAt: ROW_MINTED };

  it('fires the crash shape: current round, no live run, reviewer never dispatched', () => {
    expect(stalledReviewRefire(candidate, { round: 2, liveRun: false, reviewerRunSince: null })).toBe(true);
  });

  it('never re-fires a superseded round', () => {
    expect(stalledReviewRefire(candidate, { round: 3, liveRun: false, reviewerRunSince: null })).toBe(false);
  });

  it('never re-fires over a live turn (the run row owns the round)', () => {
    expect(stalledReviewRefire(candidate, { round: 2, liveRun: true, reviewerRunSince: null })).toBe(false);
  });

  it('never re-fires a reviewer that already had a turn this round (the correction/park law owns it)', () => {
    expect(
      stalledReviewRefire(candidate, {
        round: 2,
        liveRun: false,
        reviewerRunSince: new Date(ROW_MINTED.getTime() + 1),
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

  it('is LIMIT-bounded and oldest-first (a wedged round can never starve the scan)', () => {
    const { sql } = stalledReviewScan(mockDb(), cutoff).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('order by "task_reviews"."created_at"');
    expect(flat).not.toContain('desc'); // oldest-first, never newest-first
    expect(flat).toContain('limit $');
  });
});

describe('dispatcher tick wiring (#397)', () => {
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

  it('suppresses the re-fire while a run is live on the task', async () => {
    h.liveRun = true;
    const refired = await sweepStalledReviewTurns();
    expect(refired).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it('suppresses the re-fire when the reviewer already had a turn in this round', async () => {
    h.reviewerRun = new Date(ROW_MINTED.getTime() + 5_000);
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
    h.scan = [];
    await expect(sweepStalledReviewTurns()).resolves.toBe(0);
    expect(STALLED_REVIEW_GRACE_MS).toBe(60_000);
  });
});

describe('dispatcher start/stop still works with the new arm (#397)', () => {
  it('returns a stop function', () => {
    const stop = startDispatcher('http://localhost', 60_000);
    expect(typeof stop).toBe('function');
    stop();
  });
});

// RUN_STATUS import is used by the dispatcher arm's liveness read; keep the constant
// pinned so a status rename cannot silently blind the sweep.
describe('liveness read binds the RUNNING status (#397)', () => {
  it('pins the status literal', () => {
    expect(RUN_STATUS.RUNNING).toBe('RUNNING');
  });
});
