// ROUND-OPEN FAILURE (#282): the park only lands from in-review — a dispatch mint
// failure inside the submit's round-open window (task still working) finds nothing
// to park and must RETHROW, so openReviewRound fails the submit with the task left
// working and the just-minted rows superseded (obligations cancelled) — never a
// live round with no run in flight and no re-fire.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskReads: [] as Array<Record<string, unknown>[]>,
  reviewReads: [] as Array<Record<string, unknown>[]>,
  parkWins: false,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; pred: boolean }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  spawned: [] as string[],
  cancelledAll: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  aiEmployees: [] as Array<Record<string, unknown>>,
  dispatchError: null as Error | null,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskRuns } = await import('../../server/db/schema');
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
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: (table: unknown) => {
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
              return h.parkWins ? [{ id: 'x-1' }] : [];
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
        taskStatuses: { findMany: async () => [] },
      },
    },
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
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {
    if (h.dispatchError) throw h.dispatchError;
  },
}));

import { dispatchAiReviewTurns, openReviewRound } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.dispatchError = new Error('redis down');
  h.parkWins = false;
  h.updates = [];
  h.inserts = [];
  h.spawned = [];
  h.cancelledAll = [];
  h.notes = [];
  h.aiEmployees = [{ userId: 'rev-1' }];
});

describe('round-open dispatch failure (#282)', () => {
  it('pre-flip (task working): the park finds nothing to park — the dispatch failure rethrows, no BLOCKED flip', async () => {
    h.reviewReads = [[{ round: 1 }], [{ id: 'r1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    h.taskReads = [[{ status: STATUS.doing }]];
    await expect(dispatchAiReviewTurns('task-1', 'the result')).rejects.toThrow(/before the round opened/);
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
  });

  it('post-flip (task in-review): the park wins — BLOCKED flip recorded, no throw', async () => {
    h.reviewReads = [[{ round: 1 }], [{ id: 'r1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    h.taskReads = [[{ status: STATUS.inReview }]];
    h.parkWins = true;
    await expect(dispatchAiReviewTurns('task-1', 'the result')).resolves.toBeUndefined();
    const park = h.updates.find((u) => u.table === 'tasks');
    expect(park?.pred).toBe(true);
    expect(park?.set.status).toBe(STATUS.blocked);
  });

  it('openReviewRound: a failed dispatch supersedes the just-minted rows, cancels their obligations, and fails the submit', async () => {
    // [openReviewRound's currentRound, dispatch currentRound, dispatch rows, teardown currentRound, teardown rows]
    h.reviewReads = [
      [{ round: 1 }],
      [{ round: 2 }],
      [{ id: 'r2', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }],
      [{ round: 2 }],
      [{ id: 'r2', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }],
    ];
    h.taskReads = [[{ status: STATUS.doing }]];
    await expect(openReviewRound('task-1', ['rev-1'], 'the result')).rejects.toThrow(/before the round opened/);
    // the round row + obligation minted, then superseded/cancelled on the failure path
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]?.values).toMatchObject({ round: 2, status: REVIEW_STATUS.PENDING });
    const supersede = h.updates.find((u) => u.table === 'taskReviews');
    expect(supersede?.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.cancelledAll).toContain('APPROVAL');
    // never flipped: no BLOCKED park, no in-review submit flip
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
  });
});
