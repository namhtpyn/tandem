// TERMINAL ARBITRATION (#287): abandon's cancel write arbitrates on the status it
// read — a concurrent verdict settle (-> done) or submit flip (-> in-review) that
// won the task between the read and the write owns the outcome; the abandon loses
// (0-row miss) and never overwrites a settled task.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  cancelWins: true,
  statuses: [] as Array<{ id: string; category: string }>,
  teardowns: [] as string[],
  updates: [] as Array<{ table: string; set: Record<string, unknown>; pred: boolean }>,
  notes: [] as Array<{ kind: unknown; payload: Record<string, unknown> }>,
  published: 0,
  cancelled: [] as string[],
  spawns: [] as Array<{ employeeId: string; role: string }>,
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
        taskStatuses: { findMany: async () => h.statuses },
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
    spawnObligation: async (_t: unknown, employeeId: string, role: string) => {
      h.spawns.push({ employeeId, role: String(role) });
      return 'obl-1';
    },
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
    teardownOpenRound: async (_t: unknown, settledTo: string) => {
      h.teardowns.push(settledTo);
    },
  };
});

import { abandonTask, answerQuestion, submitResult } from '../../server/domains/tasks/workflow.service';

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
  h.statuses = [{ id: STATUS.inReview, category: CATEGORY.IN_REVIEW }];
  h.spawns = [];
  h.teardowns = [];
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

describe('submit/answer terminal arbitration (#292 r1 mirror of #287)', () => {
  it('a won submit flips in-review through a guarded write on the read status', async () => {
    h.taskRows = [
      {
        status: 'st-doing',
        assigneeId: 'worker-1',
        ownerId: 'owner-1',
        createdBy: 'owner-1',
        questionChain: [],
        reviewers: ['rev-1'],
      },
    ];
    h.statuses = [{ id: 'st-doing', category: CATEGORY.WORKING }];
    const res = await submitResult('task-1', 'worker-1', 'the work is done');
    expect(res).toEqual({ status: STATUS.inReview });
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.pred).toBe(true);
    expect(flip?.set.status).toBe(STATUS.inReview);
    expect(h.teardowns).toHaveLength(0);
  });

  it('an abandon that won between the gate read and the flip owns the outcome — the submit refuses and tears its just-opened round down', async () => {
    h.taskRows = [
      {
        status: 'st-doing',
        assigneeId: 'worker-1',
        ownerId: 'owner-1',
        createdBy: 'owner-1',
        questionChain: [],
        reviewers: ['rev-1'],
      },
    ];
    h.statuses = [{ id: 'st-doing', category: CATEGORY.WORKING }];
    h.cancelWins = false;
    await expect(submitResult('task-1', 'worker-1', 'the work is done')).rejects.toThrow(
      /task state changed during submit/,
    );
    expect(h.teardowns).toContain('submit lost the race');
    // the losing flip was the only tasks write (no park-disarm: it could only ever
    // strip a concurrent round's legitimate park recovery state, #292 r3)
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(1);
  });

  it('a submit with no reviewers flips DONE through the same guarded write', async () => {
    h.taskRows = [
      {
        status: 'st-doing',
        assigneeId: 'worker-1',
        ownerId: 'owner-1',
        createdBy: 'owner-1',
        questionChain: [],
        reviewers: [],
      },
    ];
    h.statuses = [{ id: 'st-doing', category: CATEGORY.WORKING }];
    const res = await submitResult('task-1', 'worker-1', 'the work is done');
    expect(res).toEqual({ status: STATUS.done });
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.pred).toBe(true);
    expect(flip?.set.status).toBe(STATUS.done);
  });

  it('a late answer losing the race to a settle refuses — the settled outcome stands', async () => {
    h.taskRows = [
      {
        status: STATUS.waitingAnswer,
        assigneeId: 'worker-1',
        ownerId: 'owner-1',
        createdBy: 'owner-1',
        questionChain: ['owner-1'],
        reviewers: [],
      },
    ];
    h.statuses = [{ id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER }];
    h.cancelWins = false;
    await expect(answerQuestion('task-1', 'owner-1', 'here is the answer')).rejects.toThrow(
      /task state changed during answer/,
    );
    // the settle owns the outcome, OBLIGATIONS INCLUDED (#314 r1): a lost answer
    // race cancels NOTHING — no ANSWER cancel, no heal spawn on the settled task
    expect(h.cancelled).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
  });
});
