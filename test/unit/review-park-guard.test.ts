// REVIEW SETTLE-FAILURE PARK (#199): parkRound parks ONLY from in-review — a manual
// settle that won the race owns the outcome (parking over a terminal/owner-moved
// status would resurrect a dead round), and the park write carries the atomic
// in-review predicate so a concurrent settle between read and write wins.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; hasPredicate: boolean }>,
  activities: [] as Array<{ body: string }>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: () => ({
          where: async () => h.taskRows,
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            then: <R>(onFulfilled?: (v: undefined) => R) => {
              h.updates.push({ table: table === tasks ? 'tasks' : 'other', set, hasPredicate: cond != null });
              return Promise.resolve(undefined).then(() => onFulfilled?.(undefined));
            },
          }),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string }) => {
      h.activities.push({ body: args.body });
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { parkRound } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskRows = [];
  h.updates = [];
  h.activities = [];
});

describe('parkRound in-review guard (#199)', () => {
  it('a task that left in-review (manual settle won) is NOT parked', async () => {
    h.taskRows = [{ status: STATUS.done, ownerId: 'u1' }];
    await parkRound('task-1', 'review turn timed out — reaped after 45 min');
    expect(h.updates).toHaveLength(0);
    expect(h.activities).toHaveLength(0);
  });

  it('an in-review task parks: BLOCKED write with the atomic predicate + thread note', async () => {
    h.taskRows = [{ status: STATUS.inReview, ownerId: 'u1' }];
    await parkRound('task-1', 'review turn timed out — reaped after 45 min');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.table).toBe('tasks');
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.hasPredicate).toBe(true);
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]?.body).toContain('review parked — review turn timed out');
  });
});
