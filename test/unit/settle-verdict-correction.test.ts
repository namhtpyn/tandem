// VERDICT-LESS BOUND (#276): the settle path's re-dispatch is PER ROUND and binds
// to the SETTLING run's dispatched round — a reviewer returning in a later round
// still gets their corrected retry, a stale settle never touches the live round,
// and the corrected retry is consumed only by a PRIOR COMPLETED (DONE) turn in the
// same round: a reaped/failed turn is not a verdict-less attempt.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  round: 1 as number,
  boundRow: { round: 1, createdAt: new Date('2026-11-03T00:00:00Z') } as { round: number; createdAt: Date } | null,
  seenAt: null as Date | null,
  runs: [] as Array<{ id: string; startedAt: Date | null; status?: string }>,
  dispatched: [] as Array<Record<string, unknown>>,
  parks: [] as string[],
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskRuns: { findMany: async () => h.runs },
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    currentRound: async () => h.round,
    dispatchedReviewRoundRow: async (_taskId: string, _reviewerId: string, at?: Date) => {
      h.seenAt = at ?? null;
      return h.boundRow;
    },
    dispatchAiReviewTurns: async (_taskId: string, _body?: string, opts?: Record<string, unknown>) => {
      h.dispatched.push(opts ?? {});
    },
    parkRound: async (_taskId: string, why: string) => {
      h.parks.push(why);
    },
  };
});

import { settleReviewVerdict } from '../../server/domains/tasks/runner.service';

const roundOpen = new Date('2026-11-03T00:00:00Z');
const run = (id: string, at: Date, status = 'DONE') => ({ id, startedAt: at, status });
const self = new Date(roundOpen.getTime() + 5000); // the settling run's start

beforeEach(() => {
  h.round = 1;
  h.boundRow = { round: 1, createdAt: roundOpen };
  h.seenAt = null;
  h.runs = [];
  h.dispatched = [];
  h.parks = [];
});

describe('settleReviewVerdict verdict-less bound (#276)', () => {
  it('round 1, first completed turn -> corrected re-dispatch bound to the reviewer', async () => {
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    // the settling run's start drives the round binding (never the latest-run lookup)
    expect(h.seenAt?.getTime()).toBe(self.getTime());
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.verdictCorrection).toBe(true);
    expect(h.dispatched[0]?.verdictlessReviewerId).toBe('rev-1');
  });

  it('a returning reviewer in round 2 with only a PREVIOUS-round turn still gets the corrected retry', async () => {
    // pre-fix defect: lifetime count (round 1 run + round 2 run = 2) parked here
    h.round = 2;
    h.boundRow = { round: 2, createdAt: roundOpen };
    h.runs = [run('old-r1', new Date(roundOpen.getTime() - 86_400_000)), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
  });

  it('a PRIOR completed turn this round -> decision park (the corrected retry already failed)', async () => {
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000)), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('finished without a verdict after a re-dispatch');
  });

  it('a REAPED (failed) turn never consumes the corrected retry', async () => {
    // blind-review r4: only a completed verdict-less turn is a used attempt
    h.runs = [run('reaped', new Date(roundOpen.getTime() + 1000), 'FAILED'), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
  });

  it('a STALE settle (dispatched round behind current) is a quiet no-op — the live round owns progression', async () => {
    h.round = 2;
    h.boundRow = { round: 1, createdAt: roundOpen };
    h.runs = [run('stale', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(0);
  });

  it('no dispatched round row is an anomaly -> decision park, never a correction dispatch', async () => {
    h.boundRow = null;
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('no round row for the reviewer');
  });
});
