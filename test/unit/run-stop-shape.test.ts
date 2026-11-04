// STOP-RUN CAS LAW (#229): stopRunForTask is ONE conditional flip of the run
// row — `id = run AND status = RUNNING` — whose RETURNING arbitrates the race
// against the agent's own settle: 0 rows = the turn landed first, the stop is
// an idempotent no-op with NO second write; 1 row = the STOPPED verdict (exit
// code cleared, finishedAt stamped, output appended) + the RUNS/activity
// publishes + (a PENDING review row present) parkRound. The builder-mock
// records the caller's WHERE predicate and the test re-renders it through the
// REAL drizzle builder (toSQL) — a mock that silently ignored the where could
// otherwise pass a predicate-less update. The review lookup's own where shape
// (taskId + the run's employeeId + PENDING) is behavior-covered by e2e per the
// no-real-DB law; here a scripted row stands in for "a pending review exists".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runCandidates: [] as Array<Record<string, unknown>>, // taskRuns.findMany — the live-run lookup
  runRow: null as Record<string, unknown> | null, // taskRuns.findFirst — optional run re-fetch
  reviewRow: null as Record<string, unknown> | null, // the PENDING task_reviews row (or none)
  casRows: [{ id: 'run-1' }] as Array<Record<string, unknown>>, // the CAS update's RETURNING
  updates: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
  published: [] as Array<[string, string]>,
  park: [] as Array<unknown[]>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns } = await import('../../server/db/schema');
  const reviewRows = () => (h.reviewRow ? [h.reviewRow] : []);
  return {
    asDb: (x: unknown) => x,
    db: {
      query: new Proxy(
        {},
        {
          get: (_t, table: string) => ({
            // DB-MOCK PREDICATE LAW: the mock HONORS the caller's where — the
            // live-run lookup pushes status = RUNNING into SQL, so candidates
            // whose status differs must never reach the service as "live"
            findMany: async (cfg?: { where?: { status?: { eq?: string } } }) => {
              if (table !== 'taskRuns') return [];
              const want = cfg?.where?.status?.eq;
              return want ? h.runCandidates.filter((r) => r.status === want) : h.runCandidates;
            },
            findFirst: async () => (table === 'taskReviews' ? h.reviewRow : h.runRow),
          }),
        },
      ),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => {
            const entry = { table: table === taskRuns ? 'taskRuns' : 'other', set, where };
            return {
              returning: async () => {
                h.updates.push(entry);
                return h.casRows;
              },
            };
          },
        }),
      }),
      // the pending-review probe: tolerated both as a select chain and (via the
      // query proxy above) as an RQB findFirst
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => reviewRows(),
            then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
              Promise.resolve(reviewRows()).then(onF, onR),
          }),
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

// parkRound is dynamically imported by the settle paths and statically by the
// service — the mock intercepts BOTH; its internal db chain never runs here
vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    parkRound: async (...args: unknown[]) => {
      h.park.push(args);
    },
  };
});

import { REVIEW_STATUS, RUN_STATUS } from '#shared/enums';

import { executeRun, stopRunForTask, stoppedRunMarkerIds } from '../../server/domains/tasks/runner.service';
import { mockDb, taskRuns } from './helpers/mock-db';

const liveCandidate = { id: 'run-1', status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' };

beforeEach(() => {
  h.runCandidates = [];
  h.runRow = null;
  h.reviewRow = null;
  h.casRows = [{ id: 'run-1' }];
  h.updates = [];
  h.published = [];
  h.park = [];
});

describe('stopRunForTask (#229) — the CAS shape', () => {
  it('no live run: { ok: true, stopped: false } with ZERO writes', async () => {
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: false });
    expect(h.updates).toHaveLength(0);
    expect(h.published).toHaveLength(0);
    expect(h.park).toHaveLength(0);

    // a terminal-only run history is not a live run either
    h.runCandidates = [{ id: 'run-0', status: RUN_STATUS.DONE, employeeId: 'ai-1' }];
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: false });
    expect(h.updates).toHaveLength(0);
  });

  it('live run: exactly ONE CAS update — id AND status-RUNNING conjunction, STOPPED payload', async () => {
    h.runCandidates = [liveCandidate];
    h.reviewRow = null; // no pending review → no park arm
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(h.updates).toHaveLength(1);
    const upd = h.updates[0];
    expect(upd.table).toBe('taskRuns');
    // payload pins: STOPPED verdict, exit code cleared, finishedAt stamped, output appended
    expect(upd.set.status).toBe(RUN_STATUS.STOPPED);
    expect(upd.set.status).toBe('STOPPED'); // raw wire token — never an undefined-vs-undefined pass
    expect(upd.set).toHaveProperty('exitCode', null);
    expect(upd.set.finishedAt).toBeInstanceOf(Date);
    expect(upd.set.output).toBeDefined();
    // re-render the caller's recorded WHERE through the REAL drizzle builder:
    // the CAS predicate must exist on the update, not be dropped by the mock
    const { sql, params } = mockDb()
      .update(taskRuns)
      .set(upd.set as never)
      .where(upd.where as never)
      .toSQL();
    expect(sql).toContain('task_runs');
    expect(sql).toMatch(/\sand\s/i); // the CAS conjunction exists
    expect(sql).toContain('"task_runs"."id"');
    expect(sql).toContain('"task_runs"."status"');
    expect(params).toContain('run-1');
    expect(params).toContain('RUNNING');
    // the output append rides the SET (the sql`` chunk renders literally)
    expect(sql).toContain('coalesce("task_runs"."output"');
    expect(sql).toContain('[run] stopped');
    // a landed row publishes the runs feed + the task surface (the RUN LOCK's
    // release reaches list/board viewers, #264) + activity, never parks without a review
    expect(h.published).toHaveLength(3);
    expect(h.published).toEqual(
      expect.arrayContaining([
        ['RUNS', 'UPDATE'],
        ['TASKS', 'UPDATE'],
        ['TASK_ACTIVITY', 'CREATE'],
      ]),
    );
    expect(h.park).toHaveLength(0);
  });

  it('returning([]) — the turn settled first: { ok: true, stopped: false }, no second write', async () => {
    h.runCandidates = [liveCandidate];
    h.casRows = [];
    // a pending review row EXISTS, but the lost race must skip the park too
    h.reviewRow = { id: 'rev-1', taskId: 'task-1', employeeId: 'ai-1', status: REVIEW_STATUS.PENDING };
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: false });
    expect(h.updates).toHaveLength(1); // the CAS attempt, and nothing after it
    expect(h.published).toHaveLength(0); // a lost race publishes nothing
    expect(h.park).toHaveLength(0);
  });

  it('row landed + a PENDING review row: parkRound parks the round with rearm disabled', async () => {
    h.runCandidates = [liveCandidate];
    h.reviewRow = { id: 'rev-1', taskId: 'task-1', employeeId: 'ai-1', status: REVIEW_STATUS.PENDING };
    h.runRow = { ...liveCandidate }; // served if the implementation re-fetches the run row
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(h.updates).toHaveLength(1); // still exactly one write
    expect(h.park).toEqual([['task-1', 'review turn stopped — needs a human', { rearmable: false }]]);
  });
});

describe('stop-marker lifecycle across executeRun (#291 F9)', () => {
  it('a stop that settled a queued run leaves NO marker after the pre-try guard return', async () => {
    // the stop lands while the run is still RUNNING (queued / between attempts):
    // the verb adds the marker pre-CAS and the CAS wins
    h.runCandidates = [liveCandidate];
    h.casRows = [{ id: 'run-1' }];
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(stoppedRunMarkerIds()).toContain('run-1');
    // the worker then picks the job — the guard sees the STOPPED row (settled
    // elsewhere) and refuses pre-try: the marker's consumers live inside the try,
    // so the marker must be deleted here, not leaked forever (unbounded Set)
    h.runRow = { ...liveCandidate, status: RUN_STATUS.STOPPED };
    await expect(executeRun('run-1', 'http://localhost:3000', { attempt: 1, maxAttempts: 3 })).resolves.toEqual({
      status: RUN_STATUS.FAILED,
      exitCode: null,
    });
    expect(stoppedRunMarkerIds()).not.toContain('run-1');
  });

  it('a lost stop race unwinds the marker at the verb — executeRun sees none', async () => {
    h.runCandidates = [liveCandidate];
    h.casRows = []; // the turn settled first with its own verdict
    await expect(stopRunForTask('task-1', 'user-1')).resolves.toEqual({ ok: true, stopped: false });
    expect(stoppedRunMarkerIds()).not.toContain('run-1'); // the verb's own unwind (#229)
  });
});
