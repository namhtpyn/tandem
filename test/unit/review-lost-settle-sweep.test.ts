// SETTLE-REPLAY SWEEP (#402): a review turn whose run row reached DONE but whose
// settle never landed (crash/deploy kill between finish()'s guarded RUNNING→DONE write
// and its settleDoneRun call) leaves DONE run + PENDING row + no later run + no park.
// The dispatcher tick replays the run's own settle, bounded, then parks the round.
//
// Pins, in order of strength:
//  1. the pure decision — every near-miss shape must NOT replay (task left review,
//     superseded round, live run, run not DONE, a later run) and the crash shape must;
//  2. the bound: the second replay attempt is the last — the third decision parks;
//  3. the scan's SQL carries the shape's discriminators (current round, in_review
//     category, PENDING AI row, no live run, the reviewer's NEWEST run is the DONE one);
//  4. the wiring: a crash-shaped candidate replays exactly one run and reports the heal;
//     a live run / a task out of review suppresses it; a scan failure resolves 0.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scan: [] as Array<Record<string, unknown>>,
  scanThrows: false,
  round: 2,
  liveRun: false,
  newest: null as { id: string; status: string } | null,
  taskStatus: 'st-in-review',
  statusRows: [{ id: 'st-in-review', category: 'in_review' }] as Array<{ id: string; category: string }>,
  replayed: [] as string[],
  replayOutcome: 'settled' as 'settled' | 'backoff' | 'skipped',
  taskUpdates: [] as Array<Record<string, unknown>>,
  published: 0,
}));

vi.mock('../../server/db/index', () => {
  const resolve = (projection: Record<string, unknown> | undefined) => {
    const keys = projection ? Object.keys(projection) : [];
    if (keys.includes('runId')) {
      if (h.scanThrows) return new Error('scan exploded');
      return h.scan;
    }
    if (keys.length === 1 && keys.includes('id')) return h.liveRun ? [{ id: 'run-live' }] : [];
    if (keys.includes('id') && keys.includes('status') && keys.length === 2) {
      return h.newest ? [h.newest] : [];
    }
    if (keys.includes('round')) return [{ round: h.round }];
    if (keys.includes('rearmAttempts')) return [{ status: h.taskStatus, ownerId: null, rearmAttempts: 0 }];
    if (keys.includes('status')) return [{ status: h.taskStatus }];
    return [];
  };
  const builder = (projection?: Record<string, unknown>) => {
    const rows = resolve(projection);
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
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (projection?: Record<string, unknown>) => builder(projection),
      query: { taskStatuses: { findMany: async () => h.statusRows } },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          h.taskUpdates.push(values);
          return { where: () => ({ returning: async () => [{ id: 't' }], then: async () => [] }) };
        },
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: 'msg-1' }], then: async () => [] }),
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async () => ({ id: 'msg-note' }) };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    replayLostSettle: async (runId: string) => {
      h.replayed.push(runId);
      return h.replayOutcome;
    },
  };
});

import {
  lostSettleAction,
  lostSettleAttemptState,
  lostSettleScan,
  sweepLostReviewSettles,
} from '../../server/domains/tasks/review.service';

const TASK = '00000000-0000-7000-8000-00000000b402';
const REV = '00000000-0000-7000-8000-00000000a402';
const RUN = 'run-lost';
const MINTED = new Date('2026-11-11T00:00:00Z');
const FINISHED = new Date(MINTED.getTime() + 60_000);

const candidate = {
  taskId: TASK,
  round: 2,
  reviewerId: REV,
  createdAt: MINTED,
  runId: RUN,
  finishedAt: FINISHED,
};

const shape = { round: 2, liveRun: false, inReview: true, runStatus: 'DONE', runIsNewest: true };

beforeEach(() => {
  lostSettleAttemptState.clear(); // module state: attempts are per-run and per-process
  h.scan = [{ ...candidate }];
  h.scanThrows = false;
  h.round = 2;
  h.liveRun = false;
  h.newest = { id: RUN, status: 'DONE' };
  h.taskStatus = 'st-in-review';
  h.replayed = [];
  h.replayOutcome = 'settled';
  h.taskUpdates = [];
});

describe('lostSettleAction (#402 pure decision)', () => {
  it('replays the crash shape: current round, no live run, newest run DONE', () => {
    expect(lostSettleAction(candidate, shape, 0)).toBe('replay');
  });

  it('never replays a task that left in-review (manual move / park while scanning)', () => {
    expect(lostSettleAction(candidate, { ...shape, inReview: false }, 0)).toBeNull();
  });

  it('never replays a superseded round', () => {
    expect(lostSettleAction(candidate, { ...shape, round: 3 }, 0)).toBeNull();
  });

  it('never replays while a turn is live on the task', () => {
    expect(lostSettleAction(candidate, { ...shape, liveRun: true }, 0)).toBeNull();
  });

  it('never replays a run that is not DONE (a failed turn has its own park ladder)', () => {
    expect(lostSettleAction(candidate, { ...shape, runStatus: 'FAILED' }, 0)).toBeNull();
  });

  it('never replays when a LATER run exists (the settle landed and minted it)', () => {
    expect(lostSettleAction(candidate, { ...shape, runIsNewest: false }, 0)).toBeNull();
  });

  it('parks once the replay attempts are exhausted — the arm is bounded', () => {
    expect(lostSettleAction(candidate, shape, 1)).toBe('replay');
    expect(lostSettleAction(candidate, shape, 2)).toBe('park');
  });
});

describe('lostSettleScan (#402 SQL discriminators)', () => {
  it('carries the shape in SQL: current round, in_review, PENDING AI row, no live run, newest run DONE', async () => {
    const { SQL } = await import('bun');
    const { drizzle } = await import('drizzle-orm/bun-sql');
    const client = new SQL('postgresql://probe:probe@127.0.0.1:1/probe');
    const query = lostSettleScan(drizzle(client) as never, new Date('2026-11-11T01:00:00Z')).toSQL();
    const text = query.sql.toLowerCase();
    // placeholders carry the enum values: category = $1 (in_review), row status = $2
    // (PENDING), run status = $3 (DONE), finished_at < $4 (grace cutoff), live-run
    // probe = $5 (RUNNING)
    expect(text).toContain('task_statuses"."category" = $1');
    expect(text).toContain('task_reviews"."status" = $2');
    expect(text).toContain('task_runs"."status" = $3');
    expect(text).toContain('task_runs"."finished_at" < $4');
    expect(text).toContain('task_runs"."started_at" >= "task_reviews"."created_at"');
    expect(query.params.slice(0, 5)).toEqual(['in_review', 'PENDING', 'DONE', expect.any(String), 'RUNNING']);
    expect(text).toContain('ai_employees');
    expect(text).toContain('max(r2.round)');
    // the NEWEST-run clause: the later-run subquery compares the (started_at, id) tuple
    expect(text).toContain('(tr2.started_at, tr2.id) >');
    expect(text).toContain('limit');
    await client.close();
  });
});

describe('sweepLostReviewSettles (#402 wiring)', () => {
  it('replays the lost settle of the crash-shaped run exactly once', async () => {
    const healed = await sweepLostReviewSettles();
    expect(healed).toBe(1);
    expect(h.replayed).toEqual([RUN]);
  });

  it('suppresses the replay while a run is live on the task', async () => {
    h.liveRun = true;
    const healed = await sweepLostReviewSettles();
    expect(healed).toBe(0);
    expect(h.replayed).toEqual([]);
  });

  it('suppresses the replay when the task left the in-review category', async () => {
    h.statusRows = [{ id: 'st-in-review', category: 'done' }];
    const healed = await sweepLostReviewSettles();
    expect(healed).toBe(0);
    expect(h.replayed).toEqual([]);
  });

  it('suppresses the replay when a later run appeared between scan and decision', async () => {
    h.newest = { id: 'run-newer', status: 'RUNNING' };
    h.liveRun = false; // the task-wide live probe already passed; the run shape is stale
    const healed = await sweepLostReviewSettles();
    expect(healed).toBe(0);
    expect(h.replayed).toEqual([]);
  });

  it('keeps the attempt when the settle itself backs off, then parks on the third tick', async () => {
    h.replayOutcome = 'backoff';
    expect(await sweepLostReviewSettles()).toBe(0);
    expect(await sweepLostReviewSettles()).toBe(0);
    expect(h.replayed).toEqual([RUN, RUN]);
    // the run's attempts are exhausted: the next tick parks the round REARMABLE instead
    // of retrying forever
    expect(await sweepLostReviewSettles()).toBe(1);
    expect(h.replayed).toEqual([RUN, RUN]);
    const park = h.taskUpdates.at(-1);
    expect(park?.parkFromStatus).toBe('st-in-review');
    expect(park?.parkRearmAfter).toBeInstanceOf(Date);
  });

  it('burns the bound on a skipped replay — never replays the same run every tick forever', async () => {
    h.replayOutcome = 'skipped';
    expect(await sweepLostReviewSettles()).toBe(0);
    expect(await sweepLostReviewSettles()).toBe(0);
    expect(h.replayed).toEqual([RUN, RUN]);
    // attempts exhausted -> the round parks instead of replaying until the heat death
    expect(await sweepLostReviewSettles()).toBe(1);
    expect(h.replayed).toEqual([RUN, RUN]);
  });

  it('never rejects: a failing scan resolves 0', async () => {
    h.scanThrows = true;
    await expect(sweepLostReviewSettles()).resolves.toBe(0);
  });
});
