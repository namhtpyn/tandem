// ROUND-OPEN EXCEPTION (#282, re-homed by #394): the round open and the in-review flip
// are one transaction, so a failed open writes nothing and the submit fails on a task
// that never left its working status. The reviewer turn is dispatched only AFTER that
// commit: a dispatch failure parks the round rearmable on an in-review task, and a park
// that misses (the owner moved the task out of review) is swallowed — a landed submit is
// never reported as failed.
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskReads: [] as Array<Record<string, unknown>[]>,
  reviewReads: [] as Array<Record<string, unknown>[]>,
  parkWins: false,
  flipWins: true,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; pred: boolean }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  spawned: [] as string[],
  cancelledAll: [] as string[],
  cancelledFor: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  aiEmployees: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  dispatchError: null as Error | null,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskRuns, user } = await import('../../server/db/schema');
  const nameOf = (x: unknown) =>
    x === tasks ? 'tasks' : x === taskReviews ? 'taskReviews' : x === taskRuns ? 'taskRuns' : 'other';
  const queueFor = (table: unknown) => (table === tasks ? h.taskReads : table === taskReviews ? h.reviewReads : []);
  const thenable = (rows: () => Array<Record<string, unknown>>) => {
    const p = () => Promise.resolve(rows());
    return {
      then: (onF?: (v: Array<Record<string, unknown>>) => unknown, onR?: (e: unknown) => unknown) => p().then(onF, onR),
      catch: (onR: (e: unknown) => unknown) => p().catch(onR),
    };
  };
  const mockDb = {
    select: () => ({
      from: (table: unknown) => {
        // #364 reviewer lock: the reviewers this mock roster still holds (all of them —
        // the deletion pin lives in round-open-teardown.test.ts)
        if (table === user) {
          return {
            where: (cond: unknown) => ({
              for: async () => (new PgDialect().sqlToQuery(cond as never).params as string[]).map((id) => ({ id })),
            }),
          };
        }
        // self-chaining thenable builder: where/orderBy/limit return the builder,
        // awaiting it pops the table's FIFO (verdict-cas pattern, join-capable)
        const rows = () => queueFor(table).shift() ?? [];
        const p = () => Promise.resolve(rows());
        const self: Record<string, unknown> = {
          where: () => self,
          innerJoin: () => self,
          orderBy: () => self,
          limit: () => self,
          then: (onF?: (v: Array<Record<string, unknown>>) => unknown, onR?: (e: unknown) => unknown) =>
            p().then(onF, onR),
          catch: (onR: (e: unknown) => unknown) => p().catch(onR),
        };
        return self;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const applied = () => {
            h.updates.push({ table: nameOf(table), set, pred: cond != null });
            // the FLIP (sets in-review) and the PARK (sets blocked) arbitrate separately
            const wins = nameOf(table) === 'tasks' && set.status === STATUS.blocked ? h.parkWins : h.flipWins;
            return wins ? [{ id: 'x-1' }] : [];
          };
          return {
            ...thenable(applied),
            returning: async () => applied(),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        h.inserts.push({ table: nameOf(table), values: v });
      },
    }),
    query: {
      aiEmployees: { findMany: async () => h.aiEmployees },
      user: { findMany: async () => [] },
      employeeSupervisors: { findMany: async () => [] },
      taskStatuses: {
        // honor the caller's predicate (DB-mock predicate law): a mis-wired where
        // must FAIL the test, never be masked by an unfiltered mock
        findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
          const id = args?.where?.id?.eq;
          return id ? h.statuses.filter((s) => s.id === id) : h.statuses;
        },
      },
    },
  };
  return {
    asDb: (x: unknown) => x,
    db: { ...mockDb, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb) },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string; payload: Record<string, unknown> }) => {
      h.notes.push({ body: args.body, payload: args.payload });
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    spawnObligation: async (_t: unknown, holder: string) => void h.spawned.push(String(holder)),
    resolveObligation: async () => {},
    cancelObligations: async () => {},
    cancelAllObligations: async (_t: unknown, role: unknown) => void h.cancelledAll.push(String(role)),
    spawnObligationTracked: async (_t: unknown, employeeId: string, role: unknown) => ({
      id: `obl-${String(employeeId)}-${String(role)}`,
      created: true,
    }),
    cancelObligationById: async (obligationId: string) => void h.cancelledFor.push(obligationId),
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {
    if (h.dispatchError) throw h.dispatchError;
  },
}));

import { dispatchAiReviewTurns } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskReads.length = 0;
  h.reviewReads.length = 0;
  h.dispatchError = new Error('redis down');
  h.parkWins = false;
  h.flipWins = true;
  h.updates = [];
  h.inserts = [];
  h.spawned = [];
  h.cancelledAll = [];
  h.cancelledFor = [];
  h.notes = [];
  h.aiEmployees = [{ userId: 'rev-1' }];
  h.statuses = [
    { id: STATUS.doing, category: CATEGORY.WORKING },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
    { id: STATUS.cancelled, category: CATEGORY.CANCELLED },
  ];
});

describe('round-open dispatch failure (#282)', () => {
  // read order inside dispatchAiReviewTurns: [0] the IN-REVIEW MINT GATE's status
  // read (#401), [1] parkRound's status read, [2] the failure path's re-read that
  // classifies the park miss.
  it('the task was moved back to a working status inside the dispatch window: the park finds nothing to park — the failure rethrows, no BLOCKED flip', async () => {
    h.reviewReads = [[{ round: 1 }], [{ id: 'r1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    h.taskReads = [[{ status: STATUS.inReview }], [{ status: STATUS.doing }], [{ status: STATUS.doing }]];
    await expect(dispatchAiReviewTurns('task-1', 'the result')).rejects.toThrow(/before the round opened/);
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
  });

  it('in-review at the gate: the park wins — BLOCKED flip recorded, no throw', async () => {
    h.reviewReads = [[{ round: 1 }], [{ id: 'r1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    h.taskReads = [[{ status: STATUS.inReview }], [{ status: STATUS.inReview }]];
    h.parkWins = true;
    // #397: the mint reports whether it FIRED — a failed mint reports false and still
    // never throws at a caller that did nothing wrong
    await expect(dispatchAiReviewTurns('task-1', 'the result')).resolves.toBe(false);
    const park = h.updates.find((u) => u.table === 'tasks');
    expect(park?.pred).toBe(true);
    expect(park?.set.status).toBe(STATUS.blocked);
  });

  it('off-in-review and NOT working (owner moved to todo inside the window): the park misses and the failure stays quiet — no throw at a caller that did nothing wrong', async () => {
    h.reviewReads = [[{ round: 1 }], [{ id: 'r1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    h.taskReads = [[{ status: STATUS.inReview }], [{ status: STATUS.todo }], [{ status: STATUS.todo }]];
    // the re-check must classify `todo` as READY (the #282 branch: a caller that did
    // nothing wrong must not 500) — the fixture keeps the real category
    h.statuses = [
      { id: STATUS.doing, category: CATEGORY.WORKING },
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    ];
    // #397: the mint reports whether it FIRED — a failed mint reports false and still
    // never throws at a caller that did nothing wrong
    await expect(dispatchAiReviewTurns('task-1', 'the result')).resolves.toBe(false);
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
  });
});
