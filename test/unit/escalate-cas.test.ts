// ESCALATE VERDICT CAS (#283, #260 sibling): the escalator's row flip is its own
// arbiter — a verdict that won the race (recordVerdict CAS) or a teardown that
// superseded the row lands as a 0-row miss: the escalation refuses and mints
// NOTHING (no roster mutation, no target row, no obligation). A settled task
// never gains a phantom reviewer and a recorded verdict is never clobbered.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskReads: [] as Array<Record<string, unknown>[]>,
  reviewReads: [] as Array<Record<string, unknown>[]>,
  casMiss: false,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; pred: boolean }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  spawned: [] as string[],
  resolved: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  published: 0,
  users: [] as Array<Record<string, unknown>>,
  edges: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews } = await import('../../server/db/schema');
  const nameOf = (x: unknown) => (x === tasks ? 'tasks' : x === taskReviews ? 'taskReviews' : 'other');
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
              return h.casMiss ? [] : [{ id: 'x-1' }];
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
        user: { findMany: async () => h.users },
        employeeSupervisors: { findMany: async () => h.edges },
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
  return { ...mod, publishChange: async () => void h.published++ };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    spawnObligation: async (_t: unknown, holder: string) => void h.spawned.push(String(holder)),
    resolveObligation: async (_t: unknown, holder: string) => void h.resolved.push(String(holder)),
    cancelObligations: async () => {},
    cancelAllObligations: async () => {},
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
}));

import { escalateReview } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  // FIFO per table: [currentRound, the escalator's own row, the round's roster rows, dispatch path reads]
  h.reviewReads = [
    [{ round: 2 }],
    [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }],
    [{ reviewerId: 'rev-1' }],
    [],
    [],
  ];
  h.taskReads = [
    [{ status: STATUS.inReview, reviewers: ['rev-1'], assigneeId: 'assignee-1' }],
    [{ status: STATUS.inReview }],
  ];
  h.casMiss = false;
  h.updates = [];
  h.inserts = [];
  h.spawned = [];
  h.resolved = [];
  h.notes = [];
  h.published = 0;
  h.users = [{ id: 'sup-1', name: 'Sup' }];
  h.edges = [{ employeeId: 'rev-1', supervisorId: 'sup-1' }];
});

describe('escalateReview verdict-row CAS (#283)', () => {
  it('a won CAS escalates in order: row flip first, then roster/row/obligation mints', async () => {
    const outcome = await escalateReview('task-1', 'rev-1', 'escalate to Sup for reviewing — need eyes');
    expect(outcome).toEqual({ outcome: 'escalated' });
    const cas = h.updates.find((u) => u.table === 'taskReviews');
    const roster = h.updates.find((u) => u.table === 'tasks');
    expect(cas?.pred).toBe(true);
    expect(cas?.set.status).toBe(REVIEW_STATUS.ESCALATED);
    expect(roster?.pred).toBe(true);
    // row flip is the arbiter: it lands BEFORE the roster mutation
    expect(h.updates.indexOf(cas!)).toBeLessThan(h.updates.indexOf(roster!));
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]?.values).toMatchObject({ reviewerId: 'sup-1', round: 2, status: REVIEW_STATUS.PENDING });
    expect(h.spawned).toEqual(['sup-1']);
    expect(h.resolved).toEqual(['rev-1']);
  });

  it('a CAS miss (verdict won / teardown superseded) refuses and mints NOTHING', async () => {
    h.casMiss = true;
    await expect(escalateReview('task-1', 'rev-1', 'escalate to Sup for reviewing — need eyes')).rejects.toThrow(
      'verdict already recorded for this round',
    );
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    expect(h.published).toBe(0);
  });

  it('a settle landing inside the mint window aborts the escalation — no phantom reviewer row or obligation on the settled task', async () => {
    // post-CAS re-gate read: the task settled (cancelled) between the flip and the mint
    h.taskReads = [
      [{ status: STATUS.inReview, reviewers: ['rev-1'], assigneeId: 'assignee-1' }],
      [{ status: STATUS.cancelled }],
    ];
    const outcome = await escalateReview('task-1', 'rev-1', 'escalate to Sup for reviewing — need eyes');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.notes.some((n) => n.payload.aborted === true)).toBe(true);
  });
});
