// ANSWER-VERB GATE (#265 r2): the answer verb's gate reads the waiting_answer
// CATEGORY, never the seeded id — the composer routes the send to tasks.answer
// by category, so a custom waiting_answer-category status answers too (the
// seeded-id gate threw 'task is not waiting for an answer' on them forever,
// while both composer surfaces promised the send would work).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  flips: [] as Array<{ set: Record<string, unknown>; pred: boolean }>,
  cancelled: [] as string[],
  holder: 'human-1' as string | null,
  roundLive: false,
  updateWins: true,
  spawns: [] as string[],
  resolves: [] as string[],
  /** conditions captured from task updates (CAS predicate pin) */
  taskUpdateConds: [] as unknown[],
  /** optional queue of task reads (post-spawn arbitration) */
  taskRowQueue: [] as Array<Record<string, unknown>>,
  spawnedId: 'ob-1',
  cancelledById: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      // workflow.service's hasSupervisors selects the supervisors table
      select: () => {
        const chain = {
          from: () => chain,
          where: () => ({
            then: (onF?: (v: Array<Record<string, unknown>>) => unknown) =>
              Promise.resolve([{ supervisorId: 'sup-1' }]).then(onF),
          }),
        };
        return chain as never;
      },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            const applied = () => {
              h.flips.push({ set, pred: table === tasks });
              if (table === tasks) h.taskUpdateConds.push(_cond);
              return h.updateWins ? [{ id: 'task-1' }] : [];
            };
            return {
              returning: async () => applied(),
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
              catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
            };
          },
        }),
      }),
      query: {
        tasks: {
          findMany: async () => (h.taskRowQueue.length ? [h.taskRowQueue.shift()!] : h.taskRows),
        },
        taskStatuses: { findMany: async () => h.statuses },
        user: { findFirst: async () => ({ id: 'target-1', name: 'Target One' }) },
      },
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
    cancelObligations: async (_t: unknown, role: unknown) => void h.cancelled.push(String(role)),
    spawnObligation: async (_t: unknown, employeeId: unknown) => void h.spawns.push(String(employeeId)),
    spawnObligationTracked: async (_t: unknown, employeeId: unknown) => {
      h.spawns.push(String(employeeId));
      return { id: h.spawnedId, created: true };
    },
    resolveObligation: async (_t: unknown, employeeId: unknown) => void h.resolves.push(String(employeeId)),
    cancelObligationById: async (id: string) => void h.cancelledById.push(id),
    answerHolder: async () => h.holder,
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
    openRoundLive: async () => h.roundLive,
    dispatchAiReviewTurns: async () => {},
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async () => {} };
});

import { answerQuestion, forwardQuestion } from '../../server/domains/tasks/workflow.service';
import { mockDb, tasks as dbTasks } from './helpers/mock-db';

function seedTask(statusId: string) {
  h.taskRows = [
    {
      status: statusId,
      assigneeId: 'worker-1',
      ownerId: 'owner-1',
      createdBy: 'owner-1',
      questionChain: ['human-1'],
      reviewers: [],
      updatedAt: new Date('2026-11-08T00:00:00Z'),
    },
  ];
}

beforeEach(() => {
  h.taskRows.length = 0;
  h.statuses.length = 0;
  h.holder = 'human-1';
  h.flips = [];
  h.cancelled = [];
  h.roundLive = false;
});

describe('answer verb gate keys off the waiting_answer category (#265 r2)', () => {
  it('a CUSTOM waiting_answer-category status answers — the flip returns to to-do', async () => {
    seedTask('st-custom-waiting');
    h.statuses = [{ id: 'st-custom-waiting', category: CATEGORY.WAITING_ANSWER }];
    await answerQuestion('task-1', 'human-1', 'here is the answer');
    expect(h.cancelled).toEqual(['ANSWER']);
    expect(h.flips[0]?.set.status).toBeDefined();
    expect(h.flips[0]?.pred).toBe(true);
  });

  it('a non-waiting category refuses — the verb is not reachable there', async () => {
    seedTask('st-custom-doing');
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    await expect(answerQuestion('task-1', 'human-1', 'not an answer')).rejects.toThrow(/not waiting for an answer/);
    expect(h.cancelled).toHaveLength(0);
    expect(h.flips).toHaveLength(0);
  });

  it('a dangling status id refuses — dead input, never a guess', async () => {
    seedTask('st-legacy-dangling');
    h.statuses = [];
    await expect(answerQuestion('task-1', 'human-1', 'not an answer')).rejects.toThrow(/not waiting for an answer/);
    expect(h.flips).toHaveLength(0);
  });
});

describe('forward verb gate keys off the waiting_answer category (#265 r3 sibling)', () => {
  it('a CUSTOM waiting_answer-category status forwards — the holder moves to the target', async () => {
    seedTask('st-custom-waiting');
    h.statuses = [{ id: 'st-custom-waiting', category: CATEGORY.WAITING_ANSWER }];
    const res = await forwardQuestion('task-1', 'human-1', 'target-1', 'take this one');
    expect(res.holderId).toBe('target-1');
    // the chain-move CAS pins status + updatedAt (never a bare id update)
    const q = mockDb()
      .select()
      .from(dbTasks)
      .where(h.taskUpdateConds[0] as never)
      .toSQL();
    const sql = `${q.sql} ${JSON.stringify(q.params)}`;
    expect(sql).toContain('"status" =');
    expect(sql).toContain('"updated_at" =');
    // the VALUES, not just the columns: a regression to the seeded waiting-answer id
    // (the CATEGORY-GATE LAW dead end) or to a fresh Date instead of the read write
    // would pass a column-name check and 400 every forward on a custom status
    expect(sql).toContain('st-custom-waiting');
    expect(sql).toContain('2026-11-08T00:00:00');
  });

  it('a task that moved during the spawn window refuses and undoes ITS row (#369 r4)', async () => {
    seedTask('st-custom-waiting');
    h.statuses = [{ id: 'st-custom-waiting', category: CATEGORY.WAITING_ANSWER }];
    // first read: the gate; second read: the post-spawn arbitration
    h.taskRowQueue = [
      { ...h.taskRows[0], status: 'st-custom-waiting' },
      { ...h.taskRows[0], status: 'st-custom-todo' },
    ];
    h.statuses.push({ id: 'st-custom-todo', category: CATEGORY.READY });
    await expect(forwardQuestion('task-1', 'human-1', 'target-1', 'take this one')).rejects.toThrow(
      /task state changed during forward/,
    );
    expect(h.cancelledById).toEqual(['ob-1']);
  });

  it('a non-waiting category refuses — Forward never fires there', async () => {
    seedTask('st-custom-doing');
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    await expect(forwardQuestion('task-1', 'human-1', 'target-1', 'nope')).rejects.toThrow(/not waiting for an answer/);
  });

  it('a lost chain-move CAS refuses BEFORE any obligation write (#369 r3)', async () => {
    seedTask('st-custom-waiting');
    h.statuses = [{ id: 'st-custom-waiting', category: CATEGORY.WAITING_ANSWER }];
    h.updateWins = false; // a concurrent answer-holder return moved the task
    await expect(forwardQuestion('task-1', 'human-1', 'target-1', 'take this one')).rejects.toThrow(
      /task state changed during forward/,
    );
    expect(h.resolves).toEqual([]);
    expect(h.spawns).toEqual([]);
  });
});
