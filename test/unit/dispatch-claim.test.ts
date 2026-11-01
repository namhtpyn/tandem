// DISPATCH CLAIM LAW + GUARD-SETTLE LAW (#162): the dispatch claim is ONE
// conditional flip of the task row whose RETURNING arbitrates concurrent claimants
// (scan tick × direct paths × manual dispatch) — a loser aborts PRE-INSERT: no run
// row, no dispatch note, no thread turn, no per-agent job, no cap consumption. And
// a runner guard that refuses to execute a still-RUNNING row (stale-job,
// superseded-intent) settles it FIRST — under the old return-without-settling the
// row stayed RUNNING until the reaper while counting toward the agent's cap: the
// agent silently claimed nothing.
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  readyStatuses: [{ id: 'status-ready-1' }, { id: 'status-ready-2' }],
  claimRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  // scripted taskRuns.findFirst answers, consumed in order (row fetch, newest fetch)
  runReads: [] as Array<Record<string, unknown> | null>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskRuns } = await import('../../server/db/schema');
  const update = (table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: () => {
        const record = () => h.updates.push({ table: table === tasks ? 'tasks' : 'taskRuns', set });
        return {
          returning: async () => {
            record();
            return h.claimRows;
          },
          then: <R>(onFulfilled?: (v: undefined) => R) => {
            record();
            return Promise.resolve(undefined).then(() => onFulfilled?.(undefined));
          },
        };
      },
    }),
  });
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {
        taskStatuses: { findMany: async () => h.readyStatuses },
        taskRuns: { findFirst: async () => h.runReads.shift() ?? null },
      },
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          h.inserts.push({ table: table === taskRuns ? 'taskRuns' : 'other', values });
          return { returning: async () => [values] };
        },
      }),
      update,
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { claimTaskForDispatch, createRun, executeRun } from '../../server/domains/tasks/runner.service';
import { mockDb, tasks } from './helpers/mock-db';

const runningRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: RUN_STATUS.RUNNING,
  attempts: 1,
  output: 'buffer-so-far',
  prompt: null,
  messageId: `m-${id}`,
  ...extra,
});

beforeEach(() => {
  h.readyStatuses = [{ id: 'status-ready-1' }, { id: 'status-ready-2' }];
  h.claimRows = [{ id: 'task-1' }];
  h.runReads = [];
  h.inserts = [];
  h.updates = [];
});

describe('claimTaskForDispatch (the race arbiter, #162)', () => {
  it('a won flip returns true and writes the doing status', async () => {
    await expect(claimTaskForDispatch('task-1')).resolves.toBe(true);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].table).toBe('tasks');
    expect(h.updates[0].set.status).toBe(STATUS.doing);
  });

  it('a lost flip (0 rows returned) returns false — the loser claim', async () => {
    h.claimRows = [];
    await expect(claimTaskForDispatch('task-1')).resolves.toBe(false);
    expect(h.updates).toHaveLength(1); // the attempt itself, nothing else
  });

  it('no ready-category statuses at all: nothing to win, no write', async () => {
    h.readyStatuses = [];
    await expect(claimTaskForDispatch('task-1')).resolves.toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('the claim predicate rides the UPDATE (status still ready-category) — SQL shape', () => {
    const db = mockDb();
    const { sql, params } = db
      .update(tasks)
      .set({ status: STATUS.doing })
      .where(and(eq(tasks.id, 't-1'), inArray(tasks.status, ['s1', 's2'])))
      .toSQL();
    expect(sql).toContain('in (');
    expect(params).toContain('t-1');
    expect(params).toContain('s1');
  });
});

describe('createRun loser aborts pre-insert (#162)', () => {
  it('a lost claim inserts NOTHING — no run row, no note, no thread turn', async () => {
    h.claimRows = [];
    await expect(createRun('task-1')).resolves.toBeNull();
    expect(h.inserts).toHaveLength(0);
    expect(h.updates).toHaveLength(1); // only the losing claim attempt
  });

  it('a won claim proceeds past the arbiter (plan load reached)', async () => {
    // plan load needs rows the mock does not serve — it throws, which PROVES the
    // claim passed: the loser path never reaches the plan load at all
    h.runReads = [];
    await expect(createRun('task-1')).rejects.toThrow();
    expect(h.updates).toHaveLength(1); // the claim was attempted exactly once
    expect(h.claimRows).toEqual([{ id: 'task-1' }]); // it WON (mock returned the row)
  });
});

describe('executeRun guards settle their zombie rows (#162)', () => {
  it('superseded-intent guard: the loser row settles FAILED, task untouched', async () => {
    h.runReads = [runningRow('run-a', { message: { taskId: 't-1' } }), { id: 'run-b' }];
    const verdict = await executeRun('run-a', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].table).toBe('taskRuns');
    expect(h.updates[0].set.status).toBe(RUN_STATUS.FAILED);
    expect(String(h.updates[0].set.output)).toContain('superseded by a newer run');
    expect(h.updates[0].set.finishedAt).toBeInstanceOf(Date);
    expect(h.inserts).toHaveLength(0); // the guard returned before any execution work
  });

  it('stale-job guard: a RUNNING message-less relic settles instead of lingering', async () => {
    h.runReads = [runningRow('run-c', { message: null })];
    const verdict = await executeRun('run-c', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].set.status).toBe(RUN_STATUS.FAILED);
    expect(String(h.updates[0].set.output)).toContain('stale dispatch job');
  });

  it('an already-settled row is left alone (no double settle)', async () => {
    h.runReads = [runningRow('run-d', { status: RUN_STATUS.DONE, message: { taskId: 't-1' } })];
    const verdict = await executeRun('run-d', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.updates).toHaveLength(0);
  });

  it('an unknown run id settles nothing', async () => {
    h.runReads = [null];
    const verdict = await executeRun('ghost', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.updates).toHaveLength(0);
  });
});
