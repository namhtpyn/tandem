// REAPER REVIEW-ROUTE (#199): a stale RUNNING run whose task sits in-review is a
// timed-out REVIEW turn — the reaper parks the round on the owner instead of the
// work ladder (the old unconditional todo-flip yanked an in-review task out of its
// open round: rows stayed PENDING, nothing re-fired them). Work reaps keep the
// ladder (todo + backoff) and gain the atomic doing-guard.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  staleRuns: [] as Array<Record<string, unknown>>,
  taskRow: {} as Record<string, unknown>,
  latestRun: null as Record<string, unknown> | null,
  runUpdates: [] as Array<Record<string, unknown>>,
  taskUpdates: [] as Array<Record<string, unknown>>,
  taskWheres: [] as unknown[],
  parkCalls: [] as Array<[string, string]>,
  parkOpts: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns, tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {
        taskRuns: {
          findMany: async () => h.staleRuns,
          findFirst: async () => h.latestRun,
        },
        tasks: {
          findMany: async () => [h.taskRow],
        },
        taskStatuses: {
          findMany: async (args: { where?: { id?: { eq?: string } } }) => {
            const id = args?.where?.id?.eq;
            const category =
              id === STATUS.inReview || id === 'st-custom-review'
                ? 'in_review'
                : id === STATUS.blocked
                  ? 'paused'
                  : id === STATUS.doing || id === 'st-custom-working'
                    ? 'working'
                    : id === STATUS.done || id === 'st-custom-done'
                      ? 'done'
                      : null;
            return category ? [{ id, category }] : [];
          },
        },
      },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            if (table === tasks) h.taskWheres.push(cond);
            return {
              returning: async () => {
                if (table === taskRuns) h.runUpdates.push(set);
                return [{ id: 'run-1' }];
              },
              then: <R>(onFulfilled?: (v: undefined) => R) => {
                if (table === tasks) h.taskUpdates.push(set);
                return Promise.resolve(undefined).then(() => onFulfilled?.(undefined));
              },
            };
          },
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/settings/settings.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/settings/settings.service')>();
  return { ...mod, getRunTimeoutMs: async () => 30 * 60_000 };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});
vi.mock('../../server/domains/kernel/change-bus', () => ({ publishChange: async () => {} }));

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    parkRound: async (taskId: string, why: string, opts?: Record<string, unknown>) => {
      h.parkCalls.push([taskId, why]);
      h.parkOpts.push(opts);
    },
  };
});

import { reapStaleRuns } from '../../server/domains/tasks/dispatcher.service';
import { mockDb, tasks as mockTasks } from './helpers/mock-db';

const staleRun = () => ({
  id: 'run-1',
  status: RUN_STATUS.RUNNING,
  startedAt: new Date(Date.now() - 120 * 60_000),
  message: { taskId: 'task-1' },
});

beforeEach(() => {
  h.staleRuns = [staleRun()];
  h.taskRow = { failStreak: 0, status: STATUS.doing };
  h.latestRun = { id: 'run-1' };
  h.runUpdates = [];
  h.taskUpdates = [];
  h.taskWheres = [];
  h.parkCalls = [];
  h.parkOpts = [];
});

describe('reaper routes the follow-up by task status (#199)', () => {
  it('an in-review task: the reaped run was a review turn — park, never the todo-flip', async () => {
    h.taskRow = { failStreak: 0, status: STATUS.inReview };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.runUpdates).toHaveLength(1); // the run row settles FAILED
    expect(h.parkCalls).toEqual([['task-1', expect.stringContaining('review turn timed out')]]);
    expect(h.parkOpts[0]).toEqual({ rearmable: true }); // infra-class: the ladder owns it
    expect(h.taskUpdates).toHaveLength(0); // NO work-ladder bounce
  });

  it('a doing task: work reap keeps the ladder (todo + streak + backoff), never parks', async () => {
    h.taskRow = { failStreak: 2, status: STATUS.doing };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.parkCalls).toHaveLength(0);
    expect(h.taskUpdates).toHaveLength(1);
    expect(h.taskUpdates[0]?.status).toBe(STATUS.todo);
    expect(h.taskUpdates[0]?.failStreak).toBe(3);
    expect(h.taskUpdates[0]?.dispatchAfter).toBeInstanceOf(Date);
  });

  it('a run that lost latest-run is skipped entirely (no follow-up either way)', async () => {
    h.latestRun = { id: 'run-newer' };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1); // the row still settles
    expect(h.parkCalls).toHaveLength(0);
    expect(h.taskUpdates).toHaveLength(0);
  });

  it('a custom in-review-CATEGORY status parks the round (#336)', async () => {
    h.taskRow = { failStreak: 0, status: 'st-custom-review' };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.parkCalls).toEqual([['task-1', expect.stringContaining('review turn timed out')]]);
    expect(h.taskUpdates).toHaveLength(0);
  });

  it('a GATING auto-block (paused, in-review origin) offers the park — a timed-out review turn strands nowhere (#419)', async () => {
    // the block case: the reaper's category route used to fall through, so a timed-out
    // review turn in a derived block never reached parkRound at all
    h.taskRow = { failStreak: 0, status: STATUS.blocked };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.parkCalls).toEqual([['task-1', expect.stringContaining('review turn timed out')]]);
    expect(h.taskUpdates).toHaveLength(0); // never the work ladder
  });

  it('a custom WORKING-CATEGORY status bounces with the read-status predicate (#336)', async () => {
    h.taskRow = { failStreak: 1, status: 'st-custom-working' };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.parkCalls).toHaveLength(0);
    expect(h.taskUpdates).toHaveLength(1);
    expect(h.taskUpdates[0]?.status).toBe(STATUS.todo);
    // the guarded bounce pins the status id it READ, never the seeded doing constant
    const rendered = mockDb()
      .select()
      .from(mockTasks)
      .where(h.taskWheres[0] as never)
      .toSQL();
    expect(rendered.params).toContain('st-custom-working');
  });

  it('a custom TERMINAL-category status takes neither arm — never resurrect a settled task (#336)', async () => {
    h.taskRow = { failStreak: 0, status: 'st-custom-done' };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1); // the run row itself still settles
    expect(h.parkCalls).toHaveLength(0);
    expect(h.taskUpdates).toHaveLength(0);
  });
});
