// DISPATCH CLAIM LAW + GUARD-SETTLE LAW (#162): the dispatch claim is ONE
// conditional flip of the task row whose RETURNING arbitrates concurrent claimants
// (scan tick × direct paths × manual dispatch) — a loser aborts PRE-INSERT: no run
// row, no dispatch note, no thread turn, no per-agent job, no cap consumption. And
// a runner guard that refuses to execute a still-RUNNING row (stale-job,
// superseded-intent) settles it FIRST — under the old return-without-settling the
// row stayed RUNNING until the reaper while counting toward the agent's cap: the
// agent silently claimed nothing.
//
// CLAIM-RUN ATOMICITY (#406): the claim, the run's thread message and the RUNNING
// run row commit in ONE transaction — a working task always carries its live run,
// so the composer's liveness gate and the per-agent cap never see a claim without a
// run. Pinned by TRANSACTION IDENTITY (TX-IDENTITY PIN LAW): a boolean "inside a
// transaction" flag would stay green if the claim were hoisted into its own
// transaction, so every write must carry the SAME nonzero tx id.
import type { SQL } from 'drizzle-orm';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

type Write = {
  op: 'insert' | 'update' | 'lock';
  table: string;
  tx: number;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  mode?: string;
};

const h = vi.hoisted(() => ({
  readyStatuses: [{ id: 'status-ready-1' }, { id: 'status-ready-2' }],
  claimRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  // scripted taskRuns.findFirst answers, consumed in order (row fetch, newest fetch)
  runReads: [] as Array<Record<string, unknown> | null>,
  writes: [] as Write[],
  txSeq: 0,
  claimWhere: null as unknown,
  userRows: [{ id: 'agent-1' }] as Array<{ id: string }>,
  briefThrows: false,
  txEnters: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskRuns, taskMessages, user } = await import('../../server/db/schema');
  const tableName = (t: unknown) =>
    t === tasks ? 'tasks' : t === taskRuns ? 'taskRuns' : t === taskMessages ? 'taskMessages' : 'other';
  // one surface per executor: the base db stamps tx 0, every transaction a fresh
  // nonzero id — the identity pin reads these stamps
  const surface = (tx: number) => ({
    query: {
      taskStatuses: { findMany: async () => h.readyStatuses },
      taskRuns: { findFirst: async () => h.runReads.shift() ?? null },
      tasks: {
        findMany: async () => [{ id: 'task-1', title: 'T', description: 'D', assigneeId: 'agent-1' }],
        findFirst: async () => ({ id: 'task-1' }),
      },
      aiEmployees: {
        findMany: async () => [
          {
            userId: 'agent-1',
            environmentId: 'env-1',
            executable: 'hermes',
            providerId: null,
            model: null,
            apiKeySecretId: null,
            instructions: null,
          },
        ],
      },
      environments: {
        findMany: async () => [
          {
            id: 'env-1',
            name: 'box',
            host: 'h',
            port: '22',
            username: 'u',
            secretId: null,
            secretUsage: null,
            hostKeyFingerprint: null,
          },
        ],
      },
      user: { findMany: async () => [{ id: 'agent-1', name: 'Agent', title: null }] },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          // the lock-order key share (#400/#406) — only the user table is selected
          for: async (mode?: string) => {
            h.writes.push({ op: 'lock', table: table === user ? 'user' : 'other', tx, mode });
            return table === user ? h.userRows : [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.writes.push({ op: 'insert', table: tableName(table), tx, values });
        return { returning: async () => [{ id: 'msg-1', ...values }] };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const record = () => {
            h.writes.push({ op: 'update', table: tableName(table), tx, set });
            if (table === tasks) h.claimWhere = cond;
          };
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
    }),
  });
  return {
    asDb: (x: unknown) => x,
    db: {
      ...surface(0),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        h.txSeq += 1;
        h.txEnters += 1;
        return await fn(surface(h.txSeq));
      },
    },
  };
});

// the brief composer's read surface is not under test here — the atomicity pin needs
// only that the frozen brief reaches the run row inside the claim transaction
vi.mock('../../server/domains/tasks/brief.service', () => ({
  buildBrief: () => 'FROZEN BRIEF',
  loadBriefData: async () => {
    if (h.briefThrows) throw new Error('brief read failed');
    return {};
  },
  activityKindOf: () => null,
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { db } from '../../server/db/index';
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
  h.writes = [];
  h.txSeq = 0;
  h.claimWhere = null;
  h.userRows = [{ id: 'agent-1' }];
  h.briefThrows = false;
  h.txEnters = 0;
});

describe('claimTaskForDispatch (the race arbiter, #162)', () => {
  it('a won flip returns true and writes the doing status', async () => {
    await expect(claimTaskForDispatch('task-1', db, 'agent-1')).resolves.toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].table).toBe('tasks');
    expect(h.writes[0].set?.status).toBe(STATUS.doing);
  });

  it('a lost flip (0 rows returned) returns false — the loser claim', async () => {
    h.claimRows = [];
    await expect(claimTaskForDispatch('task-1', db, 'agent-1')).resolves.toBe(false);
    expect(h.writes).toHaveLength(1); // the attempt itself, nothing else
  });

  it('no ready-category statuses at all: nothing to win, no write', async () => {
    h.readyStatuses = [];
    await expect(claimTaskForDispatch('task-1', db, 'agent-1')).resolves.toBe(false);
    expect(h.writes).toHaveLength(0);
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

describe('createRun claim-run atomicity (#406)', () => {
  it('claim + thread message + RUNNING run row commit in ONE transaction', async () => {
    const out = await createRun('task-1');
    expect(out).toEqual({ runId: expect.any(String), employeeId: 'agent-1' });
    // employee key-share FIRST (lock order), then the claim, then message, then run
    // row — a claim held across the FK-checking inserts would invert the
    // employee-delete lock order (#400) and deadlock (40P01)
    expect(h.writes.map((w) => `${w.op}:${w.table}`)).toEqual([
      'lock:user',
      'update:tasks',
      'insert:taskMessages',
      'insert:taskRuns',
    ]);
    // the MODE is the load-bearing half: FOR UPDATE would conflict with every
    // concurrent FK check's KEY SHARE and re-open the lock cycle (#400/#406)
    expect(h.writes[0].mode).toBe('key share');
    // TRANSACTION IDENTITY: one distinct, NONZERO tx id across all three writes — a
    // hoisted claim transaction (or the old no-transaction shape, tx 0) goes red
    const ids = new Set(h.writes.map((w) => w.tx));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeGreaterThan(0);
    // the frozen brief lands WITH the row — no second prompt update after insert
    const runInsert = h.writes.find((w) => w.table === 'taskRuns');
    expect(runInsert?.values).toMatchObject({
      status: RUN_STATUS.RUNNING,
      prompt: 'FROZEN BRIEF',
      messageId: 'msg-1',
      employeeId: 'agent-1',
      environmentId: 'env-1',
    });
    expect(h.writes.filter((w) => w.op === 'update' && w.table === 'taskRuns')).toHaveLength(0);
  });

  it('the claim pins the assignee the plan was built for', async () => {
    await createRun('task-1');
    expect(h.claimWhere).not.toBeNull();
    const { sql, params } = mockDb()
      .update(tasks)
      .set({ status: STATUS.doing })
      .where(h.claimWhere as SQL)
      .toSQL();
    expect(sql).toContain('"tasks"."assignee_id"');
    expect(params).toContain('agent-1');
  });

  it('a lost claim inserts NOTHING — no message, no run row', async () => {
    h.claimRows = [];
    await expect(createRun('task-1')).resolves.toBeNull();
    // the key-share lock, then only the losing claim attempt
    expect(h.writes.map((w) => `${w.op}:${w.table}`)).toEqual(['lock:user', 'update:tasks']);
  });

  it('a read failure before the transaction writes NOTHING and opens no transaction', async () => {
    // every read (plan, brief, verdicts-so-far) lands BEFORE the transaction: a
    // failure there must not have flipped anything, inserted anything, or even
    // opened a transaction — a read moved inside the tx would be invisible to the
    // write-log pins, so the transaction counter is the arbiter
    h.briefThrows = true;
    await expect(createRun('task-1')).rejects.toThrow('brief read failed');
    expect(h.txEnters).toBe(0);
    expect(h.writes).toHaveLength(0);
  });

  it('a vanished employee row is a LOST attempt, never a raw FK error', async () => {
    h.userRows = [];
    await expect(createRun('task-1')).resolves.toBeNull();
    expect(h.writes.map((w) => `${w.op}:${w.table}`)).toEqual(['lock:user']);
  });
});

describe('executeRun guards settle their zombie rows (#162)', () => {
  it('superseded-intent guard: the loser row settles FAILED, task untouched', async () => {
    h.runReads = [runningRow('run-a', { message: { taskId: 't-1' } }), { id: 'run-b' }];
    const verdict = await executeRun('run-a', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].table).toBe('taskRuns');
    expect(h.writes[0].set?.status).toBe(RUN_STATUS.FAILED);
    expect(String(h.writes[0].set?.output)).toContain('superseded by a newer run');
    expect(h.writes[0].set?.finishedAt).toBeInstanceOf(Date);
    expect(h.writes.filter((w) => w.op === 'insert')).toHaveLength(0); // the guard returned before any execution work
  });

  it('stale-job guard: a RUNNING message-less relic settles instead of lingering', async () => {
    h.runReads = [runningRow('run-c', { message: null })];
    const verdict = await executeRun('run-c', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].set?.status).toBe(RUN_STATUS.FAILED);
    expect(String(h.writes[0].set?.output)).toContain('stale dispatch job');
  });

  it('an already-settled row is left alone (no double settle)', async () => {
    h.runReads = [runningRow('run-d', { status: RUN_STATUS.DONE, message: { taskId: 't-1' } })];
    const verdict = await executeRun('run-d', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.writes).toHaveLength(0);
  });

  it('an unknown run id settles nothing', async () => {
    h.runReads = [null];
    const verdict = await executeRun('ghost', 'http://tandem.internal', { attempt: 1, maxAttempts: 4 });
    expect(verdict).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(h.writes).toHaveLength(0);
  });
});
