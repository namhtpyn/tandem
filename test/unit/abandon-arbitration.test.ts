// TERMINAL ARBITRATION (#287): abandon's cancel write arbitrates on the status it
// read — a concurrent verdict settle (-> done) or submit flip (-> in-review) that
// won the task between the read and the write owns the outcome; the abandon loses
// (0-row miss) and never overwrites a settled task.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  cancelWins: true,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; pred: boolean }>,
  notes: [] as Array<{ kind: unknown; payload: Record<string, unknown> }>,
  published: 0,
  cancelled: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: () => {
          const self: Record<string, unknown> = {};
          self.where = () => ({ then: (onF?: (v: unknown) => unknown) => Promise.resolve([]).then(onF) });
          self.innerJoin = () => self;
          self.orderBy = () => self;
          self.limit = async () => [];
          return self;
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const applied = () => {
              h.updates.push({ table: table === tasks ? 'tasks' : 'other', set, pred: cond != null });
              return h.cancelWins ? [{ id: 'task-1' }] : [];
            };
            return {
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
              catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
              returning: async () => applied(),
            };
          },
        }),
      }),
      insert: () => ({
        values: () => {
          const p = () => Promise.resolve([{ id: 'row-1' }]);
          return {
            then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => p().then(onF),
            catch: (onR: (e: unknown) => unknown) => p().catch(onR),
            returning: async () => [{ id: 'row-1' }],
          };
        },
      }),
      query: {
        tasks: {
          findMany: async () => h.taskRows,
        },
        taskStatuses: { findMany: async () => [] },
      },
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => void h.published++ };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    cancelObligations: async (_t: unknown, role: unknown) => void h.cancelled.push(String(role)),
    cancelAllObligations: async () => {},
    spawnObligation: async () => {},
    resolveObligation: async () => {},
    answerHolder: async () => null,
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {}, hasOpenChildren: async () => false };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    openRoundLive: async () => false,
    dispatchAiReviewTurns: async () => {},
    openReviewRound: async () => 1,
    recordVerdict: async () => ({ outcome: 'superseded' }),
    currentRound: async () => 1,
    teardownOpenRound: async () => {},
  };
});

import { abandonTask } from '../../server/domains/tasks/workflow.service';

beforeEach(() => {
  h.taskRows = [
    {
      status: STATUS.inReview,
      assigneeId: 'worker-1',
      ownerId: 'owner-1',
      createdBy: 'owner-1',
      questionChain: [],
      reviewers: ['rev-1'],
    },
  ];
  h.cancelWins = true;
  h.updates = [];
  h.notes = [];
  h.published = 0;
  h.cancelled = [];
});

describe('abandonTask terminal arbitration (#287)', () => {
  it('a won cancel flips CANCELLED through a guarded write on the read status', async () => {
    const res = await abandonTask('task-1', 'owner-1', 'cancel it');
    expect(res).toEqual({ ok: true });
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.pred).toBe(true);
    expect(flip?.set.status).toBe(STATUS.cancelled);
  });

  it('a lost race (verdict settle won -> done) refuses the abandon — the settle outcome stands', async () => {
    h.cancelWins = false;
    await expect(abandonTask('task-1', 'owner-1', 'cancel it')).rejects.toThrow(/task state changed during cancel/);
    // only the losing write was attempted — no retry, no second flip
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.pred).toBe(true);
  });
});
