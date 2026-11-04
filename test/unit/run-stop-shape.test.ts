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
  gatePlanLoad: false, // #291 r3: hold loadDispatchPlan's tasks.findMany (execution parks mid-window)
  gatePlanWaiters: [] as Array<() => void>,
  gateGuardRead: false, // #291 r4: hold executeRun's guard read (execution past ENTRY, pre-guards)
  gateGuardWaiters: [] as Array<() => void>,
  failGuardRead: false, // #291 r5: the guard read REJECTS after release (db failure mid-guard)
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
              // gate hook (#291 r3 tests): hold the plan load so the execution
              // parks INSIDE the in-flight registry while the verb is driven
              if (table === 'tasks' && h.gatePlanLoad) {
                await new Promise<void>((r) => h.gatePlanWaiters.push(r));
              }
              if (table !== 'taskRuns') return [];
              const want = cfg?.where?.status?.eq;
              return want ? h.runCandidates.filter((r) => r.status === want) : h.runCandidates;
            },
            findFirst: async () => {
              // gate hook (#291 r4/r5 tests): hold the guard read so the verb can be
              // driven while the execution is past ENTRY but before its guards, and
              // optionally REJECT it on release (db failure mid-guard)
              if (table === 'taskRuns' && h.gateGuardRead) {
                await new Promise<void>((r) => h.gateGuardWaiters.push(r));
              }
              if (table === 'taskRuns' && h.failGuardRead) throw new Error('guard read db failure');
              return table === 'taskReviews' ? h.reviewRow : h.runRow;
            },
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

import {
  executeRun,
  executingRunIds,
  stopRunForTask,
  stoppedRunMarkerIds,
} from '../../server/domains/tasks/runner.service';
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
  h.gatePlanLoad = false;
  h.gatePlanWaiters = [];
  h.gateGuardRead = false;
  h.gateGuardWaiters = [];
  h.failGuardRead = false;
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

describe('stop-marker lifecycle across executeRun (#291 F9 + r3)', () => {
  it('NO in-flight execution: a won stop CAS clears the marker at the verb itself', async () => {
    // r3: the marker's consumers live inside an executeRun past its guards — with
    // none running (queued/backoff/wedged job that never replays), a won CAS has
    // NO future consumer and the verb deletes the entry immediately (the wedge-
    // then-stop shape used to leak it forever)
    const RUN_ID = 'run-f9a';
    h.runCandidates = [{ id: RUN_ID, status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' }];
    h.casRows = [{ id: RUN_ID }];
    await expect(stopRunForTask('task-f9a', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID);
    // the replayed job's stale-row guard would refuse the STOPPED row anyway —
    // the marker stays gone (idempotent belt on the pre-try returns)
    h.runRow = { id: RUN_ID, status: RUN_STATUS.STOPPED, employeeId: 'ai-1', messageId: 'm-1' };
    await expect(executeRun(RUN_ID, 'http://localhost:3000', { attempt: 1, maxAttempts: 3 })).resolves.toEqual({
      status: RUN_STATUS.FAILED,
      exitCode: null,
    });
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID);
  });

  it('a lost stop race unwinds the marker at the verb — executeRun sees none', async () => {
    const RUN_ID = 'run-f9b';
    h.runCandidates = [{ id: RUN_ID, status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' }];
    h.casRows = []; // the turn settled first with its own verdict
    await expect(stopRunForTask('task-f9b', 'user-1')).resolves.toEqual({ ok: true, stopped: false });
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID); // the verb's own unwind (#229)
  });

  it('a MID-FLIGHT execution keeps its marker through the stop; the window throw cleans both (#291 r3)', async () => {
    const RUN_ID = 'run-f9e';
    h.runCandidates = [{ id: RUN_ID, status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' }];
    h.casRows = [{ id: RUN_ID }];
    // the stale guard read must PASS: RUNNING row + message (the run is mid-flight)
    h.runRow = {
      id: RUN_ID,
      status: RUN_STATUS.RUNNING,
      employeeId: 'ai-1',
      messageId: 'm-1',
      message: { taskId: 'task-f9e' },
    };
    // hold the plan load: the execution registers itself, then PARKS mid-window
    h.gatePlanLoad = true;
    const exec = executeRun(RUN_ID, 'http://localhost:3000', { attempt: 1, maxAttempts: 3 });
    for (let i = 0; i < 200 && !executingRunIds().includes(RUN_ID); i++) await new Promise((r) => setTimeout(r, 5));
    expect(executingRunIds()).toContain(RUN_ID); // the execution registered itself
    // the stop lands while the execution is past its guards: the verb adds the
    // marker pre-CAS, wins the CAS — and must NOT clear it, the execution's
    // settle path (finish-skip + in-try early return) still consults it
    await expect(stopRunForTask('task-f9e', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(stoppedRunMarkerIds()).toContain(RUN_ID);
    // release the plan load: it fails in this harness ('task not found') — the
    // pre-try window throws and its catch cleans marker + registry before rethrow
    h.gatePlanLoad = false;
    for (const r of h.gatePlanWaiters.splice(0)) r();
    await expect(exec).rejects.toThrow();
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID);
    expect(executingRunIds()).not.toContain(RUN_ID);
  });

  it('an execution parked at its GUARD read survives the verb — entry registration (#291 r4)', async () => {
    const RUN_ID = 'run-f9g';
    h.runCandidates = [{ id: RUN_ID, status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' }];
    h.casRows = [{ id: RUN_ID }];
    // hold the GUARD read: the execution is past ENTRY (registered) but has not
    // passed its guards — the verb's post-CAS check must see it (zero blind window)
    h.gateGuardRead = true;
    const exec = executeRun(RUN_ID, 'http://localhost:3000', { attempt: 1, maxAttempts: 3 });
    for (let i = 0; i < 200 && !executingRunIds().includes(RUN_ID); i++) await new Promise((r) => setTimeout(r, 5));
    expect(executingRunIds()).toContain(RUN_ID);
    // the verb runs while the execution sits BEFORE its guards: the marker it adds
    // must survive — the execution will consume it on its post-turn settle path
    await expect(stopRunForTask('task-f9g', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(stoppedRunMarkerIds()).toContain(RUN_ID);
    // the stop won the CAS: the row is STOPPED — the guard refuses and cleans both
    h.runRow = { id: RUN_ID, status: RUN_STATUS.STOPPED, employeeId: 'ai-1', messageId: 'm-1' };
    h.gateGuardRead = false;
    for (const r of h.gateGuardWaiters.splice(0)) r();
    await expect(exec).resolves.toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID);
    expect(executingRunIds()).not.toContain(RUN_ID);
  });

  it('a GUARD-READ THROW cleans both registries — no wedge resurrection (#291 r5)', async () => {
    const RUN_ID = 'run-f9h';
    h.runCandidates = [{ id: RUN_ID, status: RUN_STATUS.RUNNING, employeeId: 'ai-1', messageId: 'm-1' }];
    h.casRows = [{ id: RUN_ID }];
    // park the execution at its guard read, drive the verb (which keeps its marker
    // because the execution is registered), then fail the guard read: the escape
    // throw must clean marker AND registry — a DB failure at the guard must never
    // resurrect the wedge-then-stop leak (both entries would otherwise outlive the
    // execution: every later stop of this runId keeps its marker forever)
    h.gateGuardRead = true;
    const exec = executeRun(RUN_ID, 'http://localhost:3000', { attempt: 1, maxAttempts: 3 });
    for (let i = 0; i < 200 && !executingRunIds().includes(RUN_ID); i++) await new Promise((r) => setTimeout(r, 5));
    expect(executingRunIds()).toContain(RUN_ID);
    await expect(stopRunForTask('task-f9h', 'user-1')).resolves.toEqual({ ok: true, stopped: true });
    expect(stoppedRunMarkerIds()).toContain(RUN_ID); // live consumer — kept
    h.failGuardRead = true;
    h.gateGuardRead = false;
    for (const r of h.gateGuardWaiters.splice(0)) r();
    await expect(exec).rejects.toThrow('guard read db failure');
    expect(stoppedRunMarkerIds()).not.toContain(RUN_ID); // the throw path cleaned it
    expect(executingRunIds()).not.toContain(RUN_ID);
  });
});
