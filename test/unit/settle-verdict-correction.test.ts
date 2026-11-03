// VERDICT-LESS BOUND (#276): the settle path's re-dispatch is PER ROUND and binds
// to the SETTLING run's dispatched round — a reviewer returning in a later round
// still gets their corrected retry, a stale settle never touches the live round,
// and the corrected retry is consumed only by a PRIOR COMPLETED (DONE) turn in the
// same round: a reaped/failed turn is not a verdict-less attempt.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  round: 1 as number,
  dispatchedRound: 1 as number,
  roundRow: { createdAt: new Date('2026-11-03T00:00:00Z') } as Record<string, unknown> | null,
  runs: [] as Array<{ id: string; startedAt: Date | null; status?: string }>,
  dispatched: [] as Array<Record<string, unknown>>,
  parks: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () =>
              table === taskReviews && cols && 'createdAt' in cols ? (h.roundRow ? [h.roundRow] : []) : [],
            then: <T>(onFulfilled?: (v: unknown[]) => T) =>
              Promise.resolve([] as unknown[]).then((v) => onFulfilled?.(v)),
          }),
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
      query: {
        taskRuns: { findMany: async () => h.runs },
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    currentRound: async () => h.round,
    dispatchedReviewRound: async () => h.dispatchedRound,
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
  h.dispatchedRound = 1;
  h.roundRow = { createdAt: roundOpen };
  h.runs = [];
  h.dispatched = [];
  h.parks = [];
});

describe('settleReviewVerdict verdict-less bound (#276)', () => {
  it('round 1, first completed turn -> corrected re-dispatch bound to the reviewer', async () => {
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.verdictCorrection).toBe(true);
    expect(h.dispatched[0]?.verdictlessReviewerId).toBe('rev-1');
  });

  it('a returning reviewer in round 2 with only a PREVIOUS-round turn still gets the corrected retry', async () => {
    // pre-fix defect: lifetime count (round 1 run + round 2 run = 2) parked here
    h.round = 2;
    h.dispatchedRound = 2;
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
    h.dispatchedRound = 1;
    h.runs = [run('stale', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(0);
  });

  it('no dispatched round (0) is an anomaly -> decision park, never a correction dispatch', async () => {
    h.dispatchedRound = 0;
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('no round row for the reviewer');
  });

  it('round row vanished between reads (TOCTOU) -> decision park', async () => {
    h.roundRow = null;
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('no round row for the reviewer');
  });
});
