// RUN SETTLE ARBITRATION (#286): writer.finish's guarded row write (status=RUNNING)
// is the settle arbiter — 0 updated rows (a reaper or cross-replica stop already
// settled the run) skips every settle side effect: no message rewrite, no
// attachments, no DONE-envelope settle, no review park, no bounce, no publishes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  casWins: true,
  appends: 0,
  casWrites: 0,
  tasksWrites: 0,
  // every WHERE the service passed to a task_runs update (streaming flush AND the
  // settle flip) — rendered through real drizzle in the predicate test below
  flipWheres: [] as unknown[],
  bodyWrites: [] as Array<[string, string, boolean]>,
  attachments: 0,
  parks: [] as Array<{ why: string; rearmable: boolean }>,
  published: [] as Array<[string, string]>,
  envelopeSettles: 0,
}));

/** fire-and-forget settles (`void settleDoneRun(...)`) escape a synchronous
 * counter read — drain several macrotask turns so an unawaited continuation
 * lands on the counter before any assertion reads it. */
const drain = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

vi.mock('../../server/db/index', async () => {
  const { taskRuns, tasks } = await import('../../server/db/schema');
  const { STATUS } = await import('../../shared/status');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: new Proxy(
        {},
        {
          get: (_t, table: string) => ({
            // bounceTaskAfterRun reads the task + the latest run before its guarded
            // tasks.write: returning a doing task + the current run lets a rogue
            // bounce REACH the write, so the tasksWrites counter actually catches
            // it (a null read would no-op the bounce and hide the regression)
            findMany: async () => (table === 'tasks' ? [{ status: STATUS.doing, failStreak: 0 }] : []),
            findFirst: async () => (table === 'taskRuns' ? { id: 'run-1' } : null),
          }),
        },
      ),
      update: (table: unknown) => ({
        set: (_set: Record<string, unknown>) => ({
          where: (_where: unknown) => {
            if (table === taskRuns) h.flipWheres.push(_where);
            const applied = () => {
              if (table === taskRuns && h.casWins) h.appends += 1;
              if (table === tasks) h.tasksWrites += 1; // bounceTaskAfterRun writes here
              h.casWrites += 1;
              return h.casWins ? [{ id: 'run-1' }] : [];
            };
            return {
              // a real thenable: the writer chains .then/.catch/.finally on flushes
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
              catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
              returning: async () => applied(),
            };
          },
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string, action: string) => {
      h.published.push([resource, action]);
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    parkRound: async (_taskId: unknown, why: string, opts?: { rearmable?: boolean }) => {
      h.parks.push({ why, rearmable: opts?.rearmable === true });
      return true;
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    updateRunMessageBody: async (messageId: string, output: string, review: boolean) => {
      h.bodyWrites.push([messageId, output, review]);
    },
    appendMessageAttachments: async () => void h.attachments++,
  };
});

vi.mock('../../server/domains/tasks/workflow.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/workflow.service')>();
  return {
    ...mod,
    submitResult: async () => {
      h.envelopeSettles += 1;
      return { status: 'done' };
    },
    askQuestion: async () => ({}),
  };
});

import { and, eq } from 'drizzle-orm';

import { setEnv } from '../../server/domains/kernel/env';
import { createRunWriter } from '../../server/domains/tasks/runner.service';
import { mockDb, taskRuns } from './helpers/mock-db';

beforeEach(() => {
  h.casWins = true;
  h.appends = 0;
  h.casWrites = 0;
  h.tasksWrites = 0;
  h.flipWheres = [];
  h.bodyWrites = [];
  h.attachments = 0;
  h.parks = [];
  h.published = [];
  h.envelopeSettles = 0;
  setEnv({ TANDEM_RUN_FLUSH_MS: undefined, TANDEM_RUN_PUBLISH_MS: undefined });
});

describe('writer.finish settle arbitration (#286)', () => {
  it('a won CAS (row still RUNNING) runs the full settle: body rewrite + review park', async () => {
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted work' },
      ai: { userId: 'agent-1' },
    });
    expect(h.bodyWrites).toHaveLength(1);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]?.rearmable).toBe(true);
  });

  it('a lost CAS (reaper/stop already settled) performs ZERO side effects', async () => {
    h.casWins = false;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted work' },
      ai: { userId: 'agent-1' },
    });
    await drain();
    expect(h.bodyWrites).toHaveLength(0);
    expect(h.attachments).toBe(0);
    expect(h.parks).toHaveLength(0);
    expect(h.published).toHaveLength(0);
    expect(h.envelopeSettles).toBe(0);
    expect(h.tasksWrites).toBe(0); // no bounce on a lost settle
  });

  it('the settle CAS renders EXACTLY id + RUNNING-status equality (operator-bound pin)', async () => {
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted work' },
      ai: { userId: 'agent-1' },
    });
    // Re-render every WHERE the service handed to a task_runs update (the streaming
    // flush + the settle flip) through the REAL drizzle builder and require exact
    // equality with the hand-built contract predicate. A pg-backed unit test is off
    // the table (test/setup.ts: the unit project runs without Postgres), so the
    // builder render is the strongest available pin. Equality (not containment)
    // binds the comparison operators: ne/inArray widening or an impossible extra
    // predicate on the CAS fails HERE — containment-only pins pass such mutants
    // while production arbitration silently flips (blind-review r1, #293).
    const renderWhere = (where: unknown) =>
      mockDb()
        .select()
        .from(taskRuns)
        .where(where as never)
        .toSQL();
    const expected = renderWhere(and(eq(taskRuns.id, 'run-1'), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    const whereClause = (rendered: { sql: string }) => rendered.sql.slice(rendered.sql.indexOf(' where ') + 7);
    expect(h.flipWheres.length).toBeGreaterThan(0);
    for (const where of h.flipWheres) {
      const actual = renderWhere(where);
      expect(whereClause(actual)).toBe(whereClause(expected));
      expect(actual.params).toEqual(['run-1', RUN_STATUS.RUNNING]);
    }
  });

  it('a lost CAS on the DONE branch skips the envelope settle (no submitResult)', async () => {
    h.casWins = false;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, { ai: { userId: 'agent-1' } });
    await drain(); // a fire-and-forget settle must land on the counter before the read
    expect(h.envelopeSettles).toBe(0);
    expect(h.bodyWrites).toHaveLength(0);
    expect(h.published).toHaveLength(0);
    expect(h.tasksWrites).toBe(0); // no bounce on a lost settle
  });

  it('a won CAS on the DONE branch settles the envelope exactly once', async () => {
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.envelopeSettles).toBe(1);
    expect(h.bodyWrites).toHaveLength(1);
  });
});
