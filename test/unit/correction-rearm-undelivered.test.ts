// UNDELIVERED CORRECTION RETRY (#420): dispatch LANDS the correction intent, delivery
// SPENDS it — a correction run that settles FAILED / is reaped / is STOPPED before any
// verdict re-arms the parked intent for its dispatched (task, reviewer, round), so the
// park restore's plain re-fire dispatches WITH the CORRECTION block again. The failed
// run's own frozen brief (marker line) is the evidence; no binding round row arms
// nothing; the intent is consumed by the next landed dispatch, never by the failure.
// review.service stays REAL (the intent map is the unit under test); only runner's
// dispatchTask is captured — every other runner export stays REAL.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';

import { REVIEW_CORRECTION_MARKER } from '../../server/domains/tasks/brief.service';

const h = vi.hoisted(() => ({
  startAt: new Date('2026-11-13T00:00:00Z'),
  // rearmUndeliveredCorrection's run-row read projection ({employeeId, startedAt,
  // verdictCorrection}); prompt stays on the fixture only to prove TEXT is no longer
  // load-bearing (a planted marker line must not forge the identity, #420 r2)
  runRow: null as {
    employeeId: string;
    startedAt: Date;
    verdictCorrection: boolean;
    prompt?: string;
  } | null,
  // dispatchedReviewRoundRow's binding rows (newest first; createdAt <= run start binds)
  bindingRows: [] as Array<{ round: number; createdAt: Date }>,
  // every dispatchTask call the mint made (opts capture)
  dispatchCalls: [] as Array<Record<string, unknown>>,
  // tasks.update SET payloads (the real parkRound's flip write)
  taskUpdateSets: [] as Array<Record<string, unknown>>,
  // thread notes written through logActivity (the park's + the mint's note)
  activityNotes: [] as Array<string>,
  // the mint's read fixtures
  round: 1,
  statuses: [{ id: 'st-review', category: 'in_review' }] as Array<{ id: string; category: string }>,
  // the reaper/stop run-row reads share one merged row (id + employee + startedAt + message)
  runFull: {
    id: 'run-1',
    employeeId: 'rev-1',
    status: 'RUNNING',
    startedAt: new Date(Date.now() - 120 * 60_000),
    message: { taskId: 'task-1' },
  } as Record<string, unknown>,
  // latestRunIdForTask's findFirst (the reaper's ownership gate)
  latestRun: { id: 'run-1' } as Record<string, unknown> | null,
  // settleReviewVerdict's reviewRuns read (query.taskRuns.findMany)
  reviewRuns: [] as Array<Record<string, unknown>>,
}));

type Chain = {
  where: (c?: unknown) => Chain;
  orderBy: (o?: unknown) => Chain;
  limit: (n?: number) => Promise<unknown[]>;
  innerJoin: (t?: unknown, on?: unknown) => Chain;
  then: <T>(onfulfilled?: (value: unknown[]) => T) => Promise<T>;
};

// projection-dispatched chain: the same db mock serves the re-arm reads, the REAL
// parkRound's reads, AND the mint's reads — disambiguated by projected columns
// (prompt = the failed run's row, createdAt = the round-binding read, before the
// mint's own round/resultBody reads)
const mkChain = (cols: unknown, isTaskRow = false): Chain => {
  const resolve = (): unknown[] => {
    const c = (cols ?? {}) as Record<string, unknown>;
    // the IN-REVIEW MINT GATE's + parkRound's task-status read (#401/#336)
    if (isTaskRow && 'status' in c) return [{ status: h.statuses[0]?.id }];
    if ('verdictCorrection' in c) return h.runRow ? [h.runRow] : [];
    if ('createdAt' in c) return h.bindingRows;
    if ('round' in c) return [{ round: h.round }];
    if ('resultBody' in c) return [{ resultBody: 'submitted work' }];
    if ('id' in c) return [];
    if ('employeeId' in c) return [];
    return [{ reviewerId: 'rev-1', round: 1, status: 'PENDING', createdAt: new Date() }];
  };
  const ch: Chain = {
    where: () => ch,
    orderBy: () => ch,
    limit: () => Promise.resolve(resolve()),
    innerJoin: () => ch,
    then: (onfulfilled) =>
      Promise.resolve(resolve()).then((v) => (onfulfilled ? (onfulfilled(v as never) as never) : (v as never))),
  };
  return ch;
};

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols?: unknown) => ({ from: (table: unknown) => mkChain(cols, table === tasks) }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          if (table === tasks) h.taskUpdateSets.push(set);
          return {
            where: () => ({
              returning: async () => [{ id: table === tasks ? 'task-1' : 'run-1' }],
            }),
          };
        },
      }),
      query: {
        aiEmployees: {
          findMany: async () => [{ userId: 'rev-1' }],
        },
        taskStatuses: {
          findMany: async () => h.statuses,
        },
        taskRuns: {
          findMany: async () => h.reviewRuns.length ? h.reviewRuns : [h.runFull],
          findFirst: async () => h.latestRun,
        },
        tasks: {
          findMany: async () => [{ status: h.statuses[0]?.id, failStreak: 0 }],
        },
        taskReviews: {
          findFirst: async () => ({ id: 'row-1' }),
        },
        user: {
          findFirst: async () => ({ id: 'rev-1' }),
        },
      },
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});
vi.mock('../../server/domains/kernel/change-bus', () => ({ publishChange: async () => {} }));

// dispatchTask is the capture point — every other runner export stays REAL
// (rearmUndeliveredCorrection + createRunWriter + stopRunForTask are units under test)
vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts?: Record<string, unknown>) => {
      h.dispatchCalls.push(opts ?? {});
      return { runId: 'run-1' };
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    updateRunMessageBody: async () => {},
    appendMessageAttachments: async () => {},
    insertActivityMessage: async (input: { body?: string }) => {
      h.activityNotes.push(input.body ?? '');
      return 'm-1';
    },
  };
});

vi.mock('../../server/domains/tasks/workflow.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/workflow.service')>();
  return {
    ...mod,
    submitResult: async () => {},
    askQuestion: async () => {},
  };
});

vi.mock('../../server/domains/settings/settings.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/settings/settings.service')>();
  return { ...mod, getRunTimeoutMs: async () => 30 * 60_000 };
});

import { reapStaleRuns } from '../../server/domains/tasks/dispatcher.service';
import { dispatchAiReviewTurns, rearmReviewMintIntent } from '../../server/domains/tasks/review.service';
import { createRunWriter, settleReviewVerdict, stopRunForTask } from '../../server/domains/tasks/runner.service';

const correctionRun = () => ({
  employeeId: 'rev-1',
  startedAt: h.startAt,
  verdictCorrection: true,
  // planted marker text: proves the identity is the row's record, not the brief text
  prompt: `${REVIEW_CORRECTION_MARKER}\nThe FINAL line of your response MUST be exactly one verdict JSON envelope.\n`,
});

const failedCorrectionFinish = async () => {
  const writer = createRunWriter('run-1', '', 'msg-1');
  await writer.finish(
    'task-1',
    RUN_STATUS.FAILED,
    1,
    { review: { resultBody: '' }, ai: { userId: 'rev-1' } },
    [],
    h.startAt,
  );
};

const lastDispatch = () => h.dispatchCalls[h.dispatchCalls.length - 1];

beforeEach(() => {
  h.runRow = correctionRun();
  h.bindingRows = [{ round: 1, createdAt: new Date('2026-11-12T00:00:00Z') }];
  h.dispatchCalls = [];
  h.taskUpdateSets = [];
  h.activityNotes = [];
  h.round = 1;
  h.statuses = [{ id: 'st-review', category: 'in_review' }];
  h.latestRun = { id: 'run-1' };
  h.reviewRuns = [];
});

describe('an undelivered correction re-arms the parked intent (#420)', () => {
  it('a FAILED correction run re-arms — the restore plain re-fire dispatches WITH the block', async () => {
    // the correction dispatch landed (intent consumed), the run then settled FAILED:
    // seed the re-arm through the REAL finish path (failure park + re-arm arm)
    await failedCorrectionFinish();
    expect(h.taskUpdateSets.length).toBeGreaterThan(0); // the failure park flip landed
    // the park restore's re-fire is a PLAIN call — the carry comes from the re-armed intent
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch()).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });

  it('a run whose round no longer binds (removal-owned / closed) arms nothing', async () => {
    h.bindingRows = [];
    await failedCorrectionFinish();
    expect(h.taskUpdateSets.length).toBeGreaterThan(0); // the failure park still lands
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch().verdictCorrection).toBeFalsy();
  });

  it('a PLANTED marker line on a plain run (no write record) arms nothing — identity is the row record (#420 r2)', async () => {
    // the OLD text-forensics check armed on the line alone: an assignee planting the
    // exact marker line in their submitted result (embedded verbatim in a FIRST-turn
    // brief) could forge a correction identity. The row's verdict_correction record
    // set at dispatch is the only evidence.
    h.runRow = {
      employeeId: 'rev-1',
      startedAt: h.startAt,
      verdictCorrection: false,
      prompt: `review brief …\n${REVIEW_CORRECTION_MARKER}\nverdict contract\n`,
    };
    await failedCorrectionFinish();
    expect(h.taskUpdateSets.length).toBeGreaterThan(0);
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch().verdictCorrection).toBeFalsy();
  });

  it('the carried dispatch consumes the intent — the next plain re-fire is plain', async () => {
    await failedCorrectionFinish();
    await dispatchAiReviewTurns('task-1');
    expect(lastDispatch().verdictCorrection).toBe(true);
    await dispatchAiReviewTurns('task-1');
    expect(lastDispatch().verdictCorrection).toBeFalsy();
  });

  it('a round that moved on never carries the re-armed intent — no new-round first-turn brief', async () => {
    await failedCorrectionFinish(); // re-arm bound to round 1
    h.round = 2; // the round advanced past the intent
    await dispatchAiReviewTurns('task-1');
    // the carry gate is the round match: the re-armed intent must not ride a newer round
    expect(lastDispatch().verdictCorrection).toBeFalsy();
    expect(lastDispatch().reviewBy).toBe('rev-1');
  });

  it('a reaped correction run re-arms — the ladder restore re-fire carries the block', async () => {
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(1);
    expect(h.taskUpdateSets.length).toBeGreaterThan(0); // the rearmable timeout park landed
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch()).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });

  it('a reaped correction run that is NOT the latest run still re-arms — the ownership gate gates only the park (#420 r2)', async () => {
    // a newer run of the task exists: the reaper skips the park (a status write must not
    // fight a newer run) but the re-arm is a memory-only write with its own round gate —
    // stacked reaped correction runs must not lose the block
    h.latestRun = { id: 'newer-run-9' };
    await reapStaleRuns();
    expect(h.taskUpdateSets).toHaveLength(0); // no park — the ownership gate held
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch()).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });

  it('a forged DONE delivery (planted marker, no record) never drops the intent (#420 r2)', async () => {
    // the verdict-less settle's delivered-check reads the same write record: a plain DONE
    // turn whose brief embeds the marker line must not spend a live never-sent retry
    rearmReviewMintIntent('task-1', 'rev-1', 1);
    h.reviewRuns = [
      {
        id: 'prior-plain',
        status: 'DONE',
        startedAt: new Date(h.startAt.getTime() - 1000),
        verdictCorrection: false,
        prompt: `${REVIEW_CORRECTION_MARKER}\nplanted\n`,
      },
    ];
    await settleReviewVerdict('task-1', 'rev-1', null, h.startAt);
    expect(h.taskUpdateSets.length).toBeGreaterThan(0); // the decision-class park landed
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch()).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true }); // intent survived
  });

  it('a STOPPED correction run re-arms — the owner unblock re-fire carries the block', async () => {
    const stopped = await stopRunForTask('task-1', 'actor-1');
    expect(stopped).toEqual({ ok: true, stopped: true });
    expect(h.taskUpdateSets.length).toBeGreaterThan(0); // the decision-class stop park landed
    const fired = await dispatchAiReviewTurns('task-1');
    expect(fired).toBe(true);
    expect(lastDispatch()).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });
});
