// SETTLE-REPLAY (#402): a review turn whose run row reached DONE but whose settle was
// lost to a crash/deploy kill between finish()'s guarded RUNNING→DONE write and its
// settleDoneRun call. The tick's lost-settle sweep replays the run row's OWN settle
// (the stored output is the settle input) instead of burning a fresh reviewer turn.
//
// Pins, in order of strength:
//  1. the replay refuses anything that is not a settle-able DONE review run (a live or
//     failed row must never be re-settled — the row guard is the first line);
//  2. the run bubble is rewritten exactly as finish() would have left it, with the
//     STORED output — not the caller's idea of it;
//  3. the verdict lands through the ordinary settle path, bound to the run's own start
//     (a stale replay can never write into a newer round);
//  4. a verdict-less stored output replays into the SAME bounded correction machinery
//     (the replay adds no second dispatch path, so the retry accounting stays honest).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runRows: [] as Array<Record<string, unknown>>,
  bodyWrites: [] as Array<{ messageId: string; body: string; isReview: boolean }>,
  verdicts: [] as Array<{ reviewerId: string; verdict: unknown; at?: Date }>,
  dispatched: [] as Array<Record<string, unknown>>,
  parks: [] as string[],
  publishes: [] as string[],
  relays: [] as string[],
  verdictThrows: null as string | null,
  round: 1,
  boundRow: { round: 1, createdAt: new Date('2026-11-11T00:00:00Z') } as { round: number; createdAt: Date } | null,
  runs: [] as Array<{ id: string; startedAt: Date | null; status?: string }>,
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskRuns: { findMany: async () => h.runs },
      user: { findFirst: async () => ({ id: 'rev-1' }) },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => h.runRows }),
        }),
        where: () => ({ limit: async () => [] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string, action: string) => {
      h.publishes.push(`${resource}:${action}`);
    },
  };
});

vi.mock('../../server/domains/channels/channels.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/channels/channels.service')>();
  return {
    ...mod,
    relaySettledRun: async (_taskId: string, runId: string) => {
      h.relays.push(runId);
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    updateRunMessageBody: async (messageId: string, body: string, isReview: boolean) => {
      h.bodyWrites.push({ messageId, body, isReview });
    },
    appendMessageAttachments: async () => {},
  };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    currentRound: async () => h.round,
    dispatchedReviewRoundRow: async () => h.boundRow,
    recordVerdict: async (
      _taskId: string,
      reviewerId: string,
      verdict: unknown,
      _note: string,
      _src: string,
      at?: Date,
    ) => {
      if (h.verdictThrows) throw new Error(h.verdictThrows);
      h.verdicts.push({ reviewerId, verdict, at });
      return 'waiting' as const;
    },
    escalateReview: async () => ({ outcome: 'escalated' as const }),
    dispatchAiReviewTurns: async (_taskId: string, _ex?: unknown, opts?: Record<string, unknown>) => {
      h.dispatched.push(opts ?? {});
      return { dispatched: 1 };
    },
    parkRound: async (_taskId: string, why: string) => {
      h.parks.push(why);
      return true;
    },
    resumeReviewQueueAfterRemoval: async () => {},
  };
});

import { replayLostSettle } from '../../server/domains/tasks/runner.service';

const RUN = 'run-402';
const MSG = 'msg-402';
const TASK = '00000000-0000-7000-8000-00000000b402';
const REV = '00000000-0000-7000-8000-00000000a402';
const STARTED = new Date('2026-11-11T00:00:00Z');

const runRow = (over: Record<string, unknown> = {}) => ({
  status: 'DONE',
  output: '{"kind":"approved","body":"looks good"}',
  employeeId: REV,
  startedAt: STARTED,
  messageId: MSG,
  taskId: TASK,
  ...over,
});

beforeEach(() => {
  h.runRows = [];
  h.bodyWrites = [];
  h.verdicts = [];
  h.dispatched = [];
  h.parks = [];
  h.publishes = [];
  h.relays = [];
  h.verdictThrows = null;
  h.round = 1;
  h.boundRow = { round: 1, createdAt: new Date('2026-11-11T00:00:00Z') };
  h.runs = [];
});

describe('replayLostSettle (#402)', () => {
  it('refuses a missing run row — nothing to replay', async () => {
    await expect(replayLostSettle(RUN)).resolves.toBe('skipped');
    expect(h.bodyWrites).toEqual([]);
  });

  it('refuses a row that is not DONE (a live/failed turn is never re-settled)', async () => {
    h.runRows = [runRow({ status: 'RUNNING' })];
    await expect(replayLostSettle(RUN)).resolves.toBe('skipped');
    expect(h.bodyWrites).toEqual([]);
  });

  it('refuses a row with no employee (nothing to bind the settle to)', async () => {
    h.runRows = [runRow({ employeeId: null })];
    await expect(replayLostSettle(RUN)).resolves.toBe('skipped');
    expect(h.bodyWrites).toEqual([]);
  });

  it('rewrites the run bubble from the STORED output, as finish() would have', async () => {
    h.runRows = [runRow()];
    await replayLostSettle(RUN);
    expect(h.bodyWrites).toEqual([{ messageId: MSG, body: '{"kind":"approved","body":"looks good"}', isReview: true }]);
  });

  it('lands the reviewer’s real verdict bound to the run’s own start', async () => {
    h.runRows = [runRow()];
    await expect(replayLostSettle(RUN)).resolves.toBe('settled');
    expect(h.verdicts).toHaveLength(1);
    expect(h.verdicts[0]?.reviewerId).toBe(REV);
    expect(h.verdicts[0]?.at?.getTime()).toBe(STARTED.getTime());
    expect(h.verdicts[0]?.verdict).toBe('APPROVED');
  });

  it('re-publishes the run/thread fan-out and relays the healed reply once', async () => {
    h.runRows = [runRow()];
    await replayLostSettle(RUN);
    expect(h.publishes).toContain('RUNS:UPDATE');
    expect(h.publishes).toContain('TASK_ACTIVITY:CREATE');
    expect(h.relays).toEqual([RUN]);
  });

  it('a business refusal is a quiet no-op in replay mode — never a park (#402 r1)', async () => {
    // the loser of a concurrent settle (another replica / an overlapping tick) hits
    // 'verdict already recorded' — the winner owns the round, so the replay must not
    // park what the winner just healed
    h.runRows = [runRow()];
    h.verdictThrows = 'verdict already recorded for this round';
    await expect(replayLostSettle(RUN)).resolves.toBe('skipped');
    expect(h.parks).toEqual([]);
    expect(h.relays).toEqual([]);
  });

  it('an INFRA throw is not a refusal — the ladder and the error log stay (#402 r2)', async () => {
    // only a business refusal is a quiet no-op; a statement timeout must keep the retry
    // ladder and park with the real diagnosis, never masquerade as 'a concurrent winner'
    h.runRows = [runRow()];
    h.verdictThrows = 'canceling statement due to statement timeout';
    await expect(replayLostSettle(RUN)).resolves.toBe('backoff');
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('settle failed');
    expect(h.relays).toEqual([]);
  });

  it('a verdict-less stored output replays into the bounded correction machinery', async () => {
    h.runRows = [runRow({ output: 'I had a look but produced no envelope' })];
    await expect(replayLostSettle(RUN)).resolves.toBe('settled');
    // the settle's own verdict-less path re-dispatches with the CORRECTION block, bound
    // to this reviewer — the replay adds no second dispatch path
    expect(h.verdicts).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.verdictCorrection).toBe(true);
    expect(h.dispatched[0]?.verdictlessReviewerId).toBe(REV);
    expect(h.parks).toEqual([]);
  });
});
