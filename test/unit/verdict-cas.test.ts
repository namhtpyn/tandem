// VERDICT CAS (#260): the verdict row write and every end-of-round task flip are
// conditional writes — the MANUAL SETTLE contract is enforced at WRITE time, not
// only by the pre-read gate. A manual settle that lands between the gate read and
// the writes must never be overridden: a torn-down row refuses the verdict, a
// won-row-but-lost-flip verdict stays recorded as audit history and keeps the
// owner's status (no settle-arm note, no publish).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  roundRows: [] as Array<Record<string, unknown>>,
  reviewRows: [] as Array<Record<string, unknown>>,
  matrixRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  casMiss: false,
  flipWins: true,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; hasPredicate: boolean }>,
  resolved: [] as string[],
  cancelledAll: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  published: 0,
  readCounter: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => {
            const resolveRows = () => {
              if (table === tasks) return Promise.resolve(h.taskRows);
              // where-only taskReviews reads: 1st = the reviewer's row, 2nd = the matrix read
              h.readCounter += 1;
              return Promise.resolve(h.readCounter === 1 ? h.reviewRows : h.matrixRows);
            };
            return {
              then: (
                onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
                onRejected?: (e: unknown) => unknown,
              ) => resolveRows().then(onFulfilled, onRejected),
              catch: (onRejected: (e: unknown) => unknown) => resolveRows().catch(onRejected),
              orderBy: () => ({ limit: async () => h.roundRows }),
            };
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              if (table === taskReviews) {
                h.updates.push({ table: 'taskReviews', set, hasPredicate: cond != null });
                return h.casMiss ? [] : [{ id: 'row-1' }];
              }
              h.updates.push({ table: 'tasks', set, hasPredicate: cond != null });
              return h.flipWins ? [{ id: 'task-1' }] : [];
            },
          }),
        }),
      }),
      query: {
        taskStatuses: {
          findMany: async () => h.statuses,
        },
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
  return {
    ...mod,
    publishChange: async () => {
      h.published += 1;
    },
  };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    resolveObligation: async (...args: unknown[]) => {
      h.resolved.push(String(args[1]));
    },
    cancelObligations: async () => {},
    cancelAllObligations: async (_taskId: unknown, role: unknown) => {
      h.cancelledAll.push(String(role));
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
}));

import { recordVerdict } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskRows = [{ status: STATUS.inReview }];
  h.roundRows = [{ round: 2 }];
  h.reviewRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
  h.matrixRows = [{ status: REVIEW_STATUS.APPROVED }, { status: REVIEW_STATUS.APPROVED }];
  h.statuses = [
    { id: 'st-todo', category: CATEGORY.READY },
    { id: 'st-review', category: CATEGORY.IN_REVIEW },
    { id: 'st-done', category: CATEGORY.DONE },
    { id: 'st-cancelled', category: CATEGORY.CANCELLED },
  ];
  h.casMiss = false;
  h.flipWins = true;
  h.updates = [];
  h.resolved = [];
  h.cancelledAll = [];
  h.notes = [];
  h.published = 0;
  h.readCounter = 0;
});

describe('recordVerdict write-time guards (#260)', () => {
  it('a unanimous approve settles with BOTH writes conditional', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const rowWrite = h.updates.find((u) => u.table === 'taskReviews');
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(rowWrite?.hasPredicate).toBe(true);
    expect(rowWrite?.set.status).toBe(REVIEW_STATUS.APPROVED);
    expect(flip?.hasPredicate).toBe(true);
    expect(flip?.set.status).toBe(STATUS.done);
    expect(h.notes[0]?.payload).toMatchObject({ approved: true, unanimous: true, round: 2 });
  });

  it('a teardown-superseded row makes the CAS miss — late verdict refused, task untouched', async () => {
    h.casMiss = true;
    await expect(recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human')).rejects.toThrow(
      'verdict already recorded for this round',
    );
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
    expect(h.resolved).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });

  it('a flip lost to a concurrent settle returns superseded — verdict row stays recorded, no settle-arm note', async () => {
    h.flipWins = false;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    const rowWrite = h.updates.find((u) => u.table === 'taskReviews');
    expect(rowWrite?.hasPredicate).toBe(true);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.hasPredicate).toBe(true);
    expect(h.notes).toHaveLength(0);
    expect(h.published).toBe(0);
    expect(h.cancelledAll).toHaveLength(0);
  });

  it('a unanimous reject cancels via the guarded flip', async () => {
    h.matrixRows = [{ status: REVIEW_STATUS.REJECTED }, { status: REVIEW_STATUS.REJECTED }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.REJECTED, '', 'human');
    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.cancelled);
    expect(h.cancelledAll.length).toBeGreaterThan(0);
  });
});
