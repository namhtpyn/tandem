// VERDICT-LESS BOUND (#276): the settle path's re-dispatch is PER ROUND — a
// reviewer returning in a later round still gets their corrected retry (the pre-fix
// lifetime count parked them on the first verdict-less turn), and the decision park
// fires only when the corrected retry ALSO produced no envelope this round.
// The dispatch carries the correction flag BOUND to the verdict-less reviewer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  round: 1 as number,
  dispatchedRound: 1 as number,
  roundRow: { createdAt: new Date('2026-11-03T00:00:00Z') } as Record<string, unknown> | null,
  runs: [] as Array<{ id: string; startedAt: Date | null }>,
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
const run = (id: string, at: Date) => ({ id, startedAt: at });

beforeEach(() => {
  h.round = 1;
  h.dispatchedRound = 1;
  h.roundRow = { createdAt: roundOpen };
  h.runs = [];
  h.dispatched = [];
  h.parks = [];
});

describe('settleReviewVerdict verdict-less bound (#276)', () => {
  it('round 1, one run this round -> corrected re-dispatch bound to the reviewer', async () => {
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000))];
    await settleReviewVerdict('task-1', 'rev-1', null);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.verdictCorrection).toBe(true);
    expect(h.dispatched[0]?.verdictlessReviewerId).toBe('rev-1');
  });

  it('a returning reviewer in round 2 with ONE run this round still gets the corrected retry', async () => {
    // pre-fix defect: lifetime count (round 1 runs + round 2 run = 2) parked here
    h.round = 2;
    h.dispatchedRound = 2;
    h.runs = [
      run('old-r1', new Date(roundOpen.getTime() - 86_400_000)), // previous round
      run('r2', new Date(roundOpen.getTime() + 1000)),
    ];
    await settleReviewVerdict('task-1', 'rev-1', null);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
  });

  it('two runs this round -> decision park (the corrected retry already failed)', async () => {
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000)), run('r2', new Date(roundOpen.getTime() + 5000))];
    await settleReviewVerdict('task-1', 'rev-1', null);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('finished without a verdict after a re-dispatch');
  });

  it('a STALE settle (dispatched round behind current) is a quiet no-op — the live round owns progression', async () => {
    // stale-run law (#276 blind-review r3): a late settle must not park the live
    // round nor put a correction block on its first-turn brief
    h.round = 2;
    h.dispatchedRound = 1;
    h.runs = [run('stale', new Date(roundOpen.getTime() + 1000))];
    await settleReviewVerdict('task-1', 'rev-1', null);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(0);
  });

  it('missing round row is an anomaly -> decision park, never a correction dispatch', async () => {
    // rows are minted before any dispatch, so a missing row is a data anomaly: the
    // safe outcome is a park (owner sees it), never a lifetime-count retry decision
    h.roundRow = null;
    h.runs = [run('old', new Date(roundOpen.getTime() - 86_400_000)), run('new', new Date(roundOpen.getTime() + 1000))];
    await settleReviewVerdict('task-1', 'rev-1', null);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('no round row for the reviewer');
  });
});
