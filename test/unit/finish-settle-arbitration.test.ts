// RUN SETTLE ARBITRATION (#286): writer.finish's guarded row write (status=RUNNING)
// is the settle arbiter — 0 updated rows (a reaper or cross-replica stop already
// settled the run) skips every settle side effect: no message rewrite, no
// attachments, no DONE-envelope settle, no review park, no bounce, no publishes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  casWins: true,
  appends: 0,
  casWrites: 0,
  tasksWrites: 0,
  // every WHERE the service passed to a task_runs update (streaming flush AND the
  // settle flip) — rendered through real drizzle in the predicate test below
  flipWheres: [] as unknown[],
  // the SET payloads of those same updates — pins the verdict + full-output tail
  flipSets: [] as Array<Record<string, unknown>>,
  // the SET payloads of tasks updates (bounce's backoff write)
  tasksSets: [] as Array<Record<string, unknown>>,
  // make the mocked submitResult throw (drives settleDoneRun's FAILURE arm)
  failSubmit: false,
  // the reviewer row is gone (the removal owns the round — no park on any path)
  reviewerDeleted: false,
  reviewerLookups: [] as Array<{ where?: { id?: { eq?: string } } }>,
  // how many publishes had fired when submitResult ran (0 = settle precedes the
  // lifecycle publishes — the r6 pin that binds ORDER, not just before-return)
  settlePublishCounts: [] as number[],
  // fixture knobs for bounceTaskAfterRun's guards (r6 blind review: the negative
  // arms of the still-doing + ladder-tier checks need overridable fixtures)
  fixtureTaskStatus: null as string | null,
  fixtureFailStreak: 0,
  // was finish() already resolved when submitResult fired? (await-discipline pin)
  finishResolved: false,
  settleResolvedAtCall: [] as boolean[],
  // did the park land while finish() was still pending? (park-arm await pin)
  parkResolvedFlags: [] as boolean[],
  // every WHERE the service passed to a tasks update (bounce's atomic re-check)
  tasksWheres: [] as unknown[],
  // how many publishes had fired when each tasks write applied (0 = write precedes
  // the lifecycle publishes, i.e. the bounce was awaited, not deferred)
  tasksWritePublishCounts: [] as number[],
  // the latest-run id the mock reports for latestRunIdForTask (overridable per test)
  latestRunId: 'run-1',
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
  await new Promise((resolve) => setTimeout(resolve, 0));
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
            findMany: async () =>
              table === 'tasks'
                ? [{ status: h.fixtureTaskStatus ?? STATUS.doing, failStreak: h.fixtureFailStreak }]
                : table === 'taskStatuses'
                  ? [
                      { id: STATUS.todo, category: 'ready' },
                      { id: STATUS.doing, category: 'working' },
                      { id: STATUS.done, category: 'done' },
                      { id: STATUS.waitingAnswer, category: 'waiting_answer' },
                      { id: STATUS.inReview, category: 'in_review' },
                      { id: STATUS.blocked, category: 'paused' },
                      { id: STATUS.cancelled, category: 'cancelled' },
                      { id: 'st-custom-working', category: 'working' },
                    ]
                  : [],
            findFirst: async (cfg?: { where?: { id?: { eq?: string } } }) => {
              if (table === 'user') {
                h.reviewerLookups.push(cfg ?? {});
                return h.reviewerDeleted ? null : { id: 'agent-1' };
              }
              return table === 'taskRuns' ? { id: h.latestRunId } : null;
            },
          }),
        },
      ),
      update: (table: unknown) => ({
        set: (_set: Record<string, unknown>) => {
          if (table === taskRuns) h.flipSets.push(_set);
          if (table === tasks) h.tasksSets.push(_set);
          return {
            where: (_where: unknown) => {
              if (table === taskRuns) h.flipWheres.push(_where);
              if (table === tasks) h.tasksWheres.push(_where);
              const applied = () => {
                if (table === taskRuns && h.casWins) h.appends += 1;
                if (table === tasks) {
                  h.tasksWrites += 1; // bounceTaskAfterRun writes here
                  h.tasksWritePublishCounts.push(h.published.length);
                }
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
          };
        },
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
      // resolve a turn later: an AWAITED park lands while finish is still pending;
      // a `void parkRound(...)` regression resolves it after finish -> flag flips
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.parkResolvedFlags.push(h.finishResolved);
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
      h.settleResolvedAtCall.push(h.finishResolved);
      h.settlePublishCounts.push(h.published.length);
      if (h.failSubmit) throw new Error('submit failed (injected)');
      return { status: 'done' };
    },
    askQuestion: async () => ({}),
  };
});

import { and, eq } from 'drizzle-orm';

import { CHANGE_ACTION, CHANGE_RESOURCE, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

import { setEnv } from '../../server/domains/kernel/env';
import { createRunWriter } from '../../server/domains/tasks/runner.service';
import { mockDb, taskRuns, tasks } from './helpers/mock-db';

/** the exact lifecycle publish sequence every won settle must emit, in order:
 * RUNS re-emit, thread-feed TASK_ACTIVITY create, then the TASKS re-emit that
 * drops viewers' runLocked bit (#264 r2) — dropping/reordering any of these is
 * a viewer-staleness regression, not a cosmetic one. */
const LIFECYCLE_PUBLISHES = [
  [CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE],
  [CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE],
  [CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE],
];

/** everything after the `where ` keyword of a rendered statement — comparing
 * this substring (not the whole SQL) keeps SET shapes out of WHERE equality */
const whereClauseOf = (rendered: { sql: string }) => rendered.sql.slice(rendered.sql.indexOf(' where ') + 7);

beforeEach(() => {
  h.casWins = true;
  h.appends = 0;
  h.casWrites = 0;
  h.tasksWrites = 0;
  h.flipWheres = [];
  h.flipSets = [];
  h.tasksSets = [];
  h.failSubmit = false;
  h.reviewerDeleted = false;
  h.settlePublishCounts = [];
  h.fixtureTaskStatus = null;
  h.fixtureFailStreak = 0;
  h.finishResolved = false;
  h.settleResolvedAtCall = [];
  h.parkResolvedFlags = [];
  h.tasksWheres = [];
  h.tasksWritePublishCounts = [];
  h.latestRunId = 'run-1';
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
    await writer
      .finish(
        'task-1',
        RUN_STATUS.FAILED,
        1,
        {
          review: { resultBody: 'submitted work' },
          ai: { userId: 'agent-1' },
        },
        ['tok-1'],
      )
      .then(() => {
        h.finishResolved = true;
      });
    expect(h.bodyWrites).toHaveLength(1);
    expect(h.bodyWrites[0]?.[2]).toBe(true); // review turn: the bubble parses as a verdict
    expect(h.attachments).toBe(1); // POSITIVE CONTROL for the lost-CAS attachments===0 pin
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]?.rearmable).toBe(true);
    expect(h.published).toEqual(LIFECYCLE_PUBLISHES);
    // await-discipline on the park arm: the park lands while finish is pending
    expect(h.parkResolvedFlags).toEqual([false]);
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
    // a LONG buffer: any plausible truncation window (the codebase's own
    // resultBody slice(-2000) included) must fail the full-tail equality below
    const longLine = 'x'.repeat(2100);
    writer.onLine(longLine);
    const t0 = new Date();
    // explicit stale runStartedAt: a mutant copying it into finishedAt must fail
    await writer.finish(
      'task-1',
      RUN_STATUS.FAILED,
      1,
      {
        review: { resultBody: 'submitted work' },
        ai: { userId: 'agent-1' },
      },
      [],
      new Date(t0.getTime() - 60_000),
    );
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
    expect(h.flipWheres.length).toBeGreaterThan(0);
    for (const where of h.flipWheres) {
      const actual = renderWhere(where);
      expect(whereClauseOf(actual)).toBe(whereClauseOf(expected));
      expect(actual.params).toEqual(['run-1', RUN_STATUS.RUNNING]);
    }
    // the flip's SET payload is contract too: the settle writes the verdict it was
    // given + the FULL output tail (transcript-tail law) — not a constant status,
    // not a truncated buffer
    const flip = h.flipSets.find((s) => s.status === RUN_STATUS.FAILED && s.output === writer.buffer);
    const setsSummary = h.flipSets.map((s) => ({
      keys: Object.keys(s),
      status: typeof s.status === 'string' ? s.status : '<non-string>',
      output: typeof s.output === 'string' ? s.output : '<sql>',
    }));
    expect(
      flip !== undefined,
      `no task_runs update wrote status=FAILED + the full output tail (sets: ${JSON.stringify(setsSummary)})`,
    ).toBe(true);
    // the settle verdict detail is contract too: exit N for a FAILED run, and a
    // finishedAt wall clock AFTER the (stale) runStartedAt we passed — thread
    // duration rendering reads the difference
    expect(flip?.exitCode).toBe(1);
    expect(flip?.finishedAt).toBeInstanceOf(Date);
    expect((flip?.finishedAt as Date).getTime()).toBeGreaterThanOrEqual(t0.getTime());
  });

  it('a won CAS on a FAILED work run bounces the task (liveness control for the no-bounce pins)', async () => {
    // POSITIVE CONTROL: proves the tasksWrites counter actually fires under this
    // file's mock — without it, mock drift would silently vacate the two
    // tasksWrites===0 pins above (a dead counter passes every "no bounce" test)
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    const t0 = new Date();
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBeGreaterThanOrEqual(1);
    expect(h.parks).toHaveLength(0); // work runs bounce, review turns park
    expect(h.bodyWrites[0]?.[2]).toBe(false); // work turn: the bubble parses as work output
    // lifecycle publishes come first and in order; the bounce adds its own
    // re-emits (tasks write + logRun) after them
    expect(h.published.slice(0, LIFECYCLE_PUBLISHES.length)).toEqual(LIFECYCLE_PUBLISHES);
    // await-discipline on the bounce arm: the guarded tasks write applied BEFORE
    // any lifecycle publish fired (0). A void/deferred bounce lands it later.
    expect(h.tasksWritePublishCounts).toEqual([0]);
    // bounce's atomic re-check is a contract predicate too: exactly
    // id + still-doing equality on the tasks row
    expect(h.tasksWheres.length).toBe(1);
    const renderTasksWhere = (where: unknown) =>
      mockDb()
        .select()
        .from(tasks)
        .where(where as never)
        .toSQL();
    const bounceWhere = renderTasksWhere(h.tasksWheres[0]);
    const expectedBounce = renderTasksWhere(and(eq(tasks.id, 'task-1'), eq(tasks.status, STATUS.doing)));
    expect(whereClauseOf(bounceWhere)).toBe(whereClauseOf(expectedBounce));
    expect(bounceWhere.params).toEqual(['task-1', STATUS.doing]);
    // the bounce's SET payload is contract: ladder climbs (0 -> 1), status moves to
    // todo, and the computed backoff lands in the FUTURE (an immediate/now stamp
    // would trigger a redispatch storm instead of a backoff wait)
    expect(h.tasksSets).toHaveLength(1);
    const bounceSet = h.tasksSets[0];
    expect(bounceSet?.status).toBe(STATUS.todo);
    expect(bounceSet?.failStreak).toBe(1);
    expect((bounceSet?.dispatchAfter as Date).getTime()).toBeGreaterThanOrEqual(t0.getTime() + 30_000);
  });

  it('a stale run never bounces the task (latest-run guard in bounceTaskAfterRun)', async () => {
    // latestRunIdForTask != this run: a late FAILED settle over a superseded run
    // must not re-arm backoff over the newer run's task (#163 shared guard)
    h.latestRunId = 'run-newer';
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBe(0);
    expect(h.published).toEqual(LIFECYCLE_PUBLISHES);
  });

  it('a custom WORKING-category status bounces too — the predicate pins the status READ (#336)', async () => {
    h.fixtureTaskStatus = 'st-custom-working';
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBe(1);
    const renderTasksWhere = (where: unknown) =>
      mockDb()
        .select()
        .from(tasks)
        .where(where as never)
        .toSQL();
    // never the seeded doing constant: the guard pins the status id read
    expect(renderTasksWhere(h.tasksWheres[0]).params).toEqual(['task-1', 'st-custom-working']);
  });

  it('a FAILED DONE settle keeps the ladder armed (settleDoneRun failure arm)', async () => {
    // submit throws -> settleDoneRun's catch: bounce the task for retry and
    // return 'backoff' BEFORE the streak reset. Mutant class (r5 blind review):
    // dropping the early return falls through to the reset — the exact documented
    // wedge "swallowing it here then resetting failStreak wedged the task".
    h.failSubmit = true;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.envelopeSettles).toBe(1); // the settle was attempted
    // the bounce fired (retry re-arm), not the success-path streak reset: every
    // tasks write here must carry the bounce's guarded re-check predicate
    expect(h.tasksWrites).toBeGreaterThanOrEqual(1);
    const renderTasksWhere = (where: unknown) =>
      mockDb()
        .select()
        .from(tasks)
        .where(where as never)
        .toSQL();
    for (const where of h.tasksWheres) {
      expect(whereClauseOf(renderTasksWhere(where))).toBe(
        whereClauseOf(renderTasksWhere(and(eq(tasks.id, 'task-1'), eq(tasks.status, STATUS.doing)))),
      );
    }
    expect(h.parks).toHaveLength(0); // work plan: bounce, not park
    expect(h.published.slice(0, LIFECYCLE_PUBLISHES.length)).toEqual(LIFECYCLE_PUBLISHES);
  });

  it('a lost CAS on a FAILED WORK run never bounces the task (the reaper-race arm)', async () => {
    // the arm production hits most: a reaper/stop racing a WORK run's finish. The
    // mutant class (bounce re-armed on a lost settle) resurrects a task the winner
    // owns — this test is what makes the two no-bounce pins above complete.
    h.casWins = false;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBe(0); // no backoff re-arm on a lost settle
    expect(h.parks).toHaveLength(0);
    expect(h.envelopeSettles).toBe(0);
    expect(h.published).toHaveLength(0);
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

  it('a won CAS on the DONE branch settles the envelope exactly once, INSIDE the awaited settle', async () => {
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    // await-discipline pin: submitResult must fire while finish() is still pending
    // (settle BEFORE the publishes/return). A `void settleDoneRun(...)` regression
    // resolves finish first — settleResolvedAtCall would read true.
    await writer.finish('task-1', RUN_STATUS.DONE, 0, { ai: { userId: 'agent-1' } }).then(() => {
      h.finishResolved = true;
    });
    await drain();
    expect(h.envelopeSettles).toBe(1);
    expect(h.settleResolvedAtCall).toEqual([false]);
    expect(h.bodyWrites).toHaveLength(1);
    // settle-vs-publish ORDER (not just before-return): submitResult fired while
    // ZERO lifecycle publishes had fired — moving the settle after the publishes
    // (M42) still reads settleResolvedAtCall=[false] but flips this counter
    expect(h.settlePublishCounts).toEqual([0]);
    // exactly ONE tasks.write on this arm: settleDoneRun's post-settle reset
    // (failStreak 0 + dispatchAfter null) — the SPEC's "streak reset only AFTER a
    // successful settle"; dropping it grows the backoff ladder across successes
    expect(h.tasksWrites).toBe(1);
    // the reset's SET payload is contract too: a successful settle disarms the
    // ladder completely (a stale failStreak=1 or kept dispatchAfter re-arms a
    // phantom backoff tier on the next failure)
    expect(h.tasksSets[0]).toMatchObject({ failStreak: 0, dispatchAfter: null });
    expect(h.published).toEqual(LIFECYCLE_PUBLISHES);
    // the DONE arm's SET payload is bound too: the verdict it was given + the
    // full output tail (a constant-FAILED mutant passes the FAILED-arm pin above)
    const doneFlip = h.flipSets.find((s) => s.status === RUN_STATUS.DONE && s.output === writer.buffer);
    expect(
      doneFlip,
      `no DONE settle SET with the full tail (sets: ${JSON.stringify(h.flipSets.map((s) => ({ keys: Object.keys(s), status: typeof s.status === 'string' ? s.status : '<non-string>', output: typeof s.output === 'string' ? s.output : '<sql>' })))})`,
    ).toBeDefined();
    expect(doneFlip?.exitCode).toBe(0);
  });

  it('finish settles EXACTLY once (the settled-once memo)', async () => {
    // attemptFailed rides on this: a second finish after a DONE settle must be a
    // full no-op — dropping the memo re-runs the CAS + settle arms (FAILED over
    // DONE, double envelope submit, double bounce)
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, { ai: { userId: 'agent-1' } });
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    // the second finish touched NOTHING: no second envelope settle, no FAILED
    // rewrite over the DONE verdict, no double reset
    expect(h.envelopeSettles).toBe(1);
    expect(h.bodyWrites).toHaveLength(1);
    expect(h.tasksWrites).toBe(1);
    expect(h.parks).toHaveLength(0);
  });

  it('a non-doing task is never resurrected (bounce still-doing guard, negative arm)', async () => {
    // cancelled/done/in-review tasks must not re-arm backoff (SPEC bounce law).
    // The fixture knob flips the read side: the mutant dropping the guard clause
    // writes anyway and this catches it.
    h.fixtureTaskStatus = STATUS.done;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBe(0);
    expect(h.published).toEqual(LIFECYCLE_PUBLISHES);
  });

  it('a quota/limit failure jumps the ladder to the longest tier (15m)', async () => {
    // SPEC resilience law: quota/limit signatures skip straight to the cap tier —
    // dropping the output argument re-dispatches a rate-limited run in 1 minute
    const writer = createRunWriter('run-1', '', 'msg-1');
    const t0 = new Date();
    writer.onLine('429 rate limit exceeded — billing');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksWrites).toBe(1);
    expect((h.tasksSets[0]?.dispatchAfter as Date).getTime()).toBeGreaterThanOrEqual(t0.getTime() + 14 * 60_000);
  });

  it('the ladder tier follows the streak (2 existing failures -> 5m wait)', async () => {
    // off-by-one in the tier index is invisible at fixture streak 0 (both land in
    // the 1m tier) — a pre-armed ladder must step UP a tier
    h.fixtureFailStreak = 1;
    const writer = createRunWriter('run-1', '', 'msg-1');
    const t0 = new Date();
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, { ai: { userId: 'agent-1' } });
    await drain();
    expect(h.tasksSets[0]?.failStreak).toBe(2);
    expect((h.tasksSets[0]?.dispatchAfter as Date).getTime()).toBeGreaterThanOrEqual(t0.getTime() + 4 * 60_000);
  });

  it('a review verdict settle failure parks REARMABLE (infra-class, #211)', async () => {
    // settleDoneRun's catch arm for review plans: an infra-class throw must park
    // on the owner with the re-arm flag — dropping { rearmable: true } wedges the
    // round as a decision park until a human
    h.failSubmit = true;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, {
      review: { resultBody: 'submitted review' },
      ai: { userId: 'agent-1' },
    });
    await drain();
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]?.rearmable).toBe(true);
    expect(h.tasksWrites).toBe(0); // review plans bounce no-ops; only the reset would write
  });

  it('a DELETED reviewer’s FAILED turn never parks (#370)', async () => {
    h.reviewerDeleted = true;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted review' },
      ai: { userId: 'agent-1' },
    });
    await drain();
    expect(h.parks).toHaveLength(0);
    // the existence lookup names THIS reviewer — a wrong id silently disables the skip
    expect(h.reviewerLookups.at(-1)?.where?.id?.eq).toBe('agent-1');
  });

  it('a DELETED reviewer’s settle throw never parks (#370)', async () => {
    h.reviewerDeleted = true;
    h.failSubmit = true;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('all work complete');
    await writer.finish('task-1', RUN_STATUS.DONE, 0, {
      review: { resultBody: 'submitted review' },
      ai: { userId: 'agent-1' },
    });
    await drain();
    expect(h.parks).toHaveLength(0);
    // the existence lookup names THIS reviewer — a wrong id silently disables the skip
    expect(h.reviewerLookups.at(-1)?.where?.id?.eq).toBe('agent-1');
  });
});
