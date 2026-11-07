// DISPATCHED-ROUND BINDING (#276 blind-review r5): the settle path resolves the
// round from the SETTLING run's start (`at`), never from the reviewer's latest run —
// a late-completing (stale) turn must bind to the round it was minted for. This
// pins the real helper (settle-verdict-correction.test.ts mocks it away).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  latestRunStartedAt: null as Date | null,
  reviewRows: [] as Array<{ round: number; createdAt: Date }>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols: Record<string, unknown>) => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => (h.latestRunStartedAt ? [{ startedAt: h.latestRunStartedAt }] : []),
              }),
            }),
          }),
          where: () => ({
            orderBy: async () => (taskReviews && cols && 'round' in cols ? h.reviewRows.map((r) => ({ ...r })) : []),
          }),
        }),
      }),
    },
  };
});

import { dispatchedReviewRound, dispatchedReviewRoundRow } from '../../server/domains/tasks/review.service';

const r1 = new Date('2026-11-01T00:00:00Z');
const r2 = new Date('2026-11-02T00:00:00Z');

beforeEach(() => {
  h.latestRunStartedAt = null;
  h.reviewRows.length = 0;
});

describe('dispatchedReviewRoundRow (#276)', () => {
  it('binds to the newest round open at the GIVEN start (the settling run), not the latest run', async () => {
    h.reviewRows = [
      { round: 2, createdAt: r2 },
      { round: 1, createdAt: r1 },
    ];
    // reviewer also ran later (round 2 mints its own turn) — the stale settle's `at`
    // predates r2, so it MUST bind to round 1
    h.latestRunStartedAt = new Date('2026-11-03T00:00:00Z');
    const stale = await dispatchedReviewRoundRow('t', 'rev', new Date('2026-11-01T12:00:00Z'));
    expect(stale?.round).toBe(1);
    // and without `at` the latest-run lookup still resolves the newest round
    const latest = await dispatchedReviewRoundRow('t', 'rev');
    expect(latest?.round).toBe(2);
    expect((await dispatchedReviewRound('t', 'rev')).toString()).toBe('2');
  });

  it('no run at all -> null (no dispatched round)', async () => {
    h.reviewRows = [];
    h.latestRunStartedAt = null;
    expect(await dispatchedReviewRoundRow('t', 'rev')).toBeNull();
    expect(await dispatchedReviewRound('t', 'rev')).toBe(0);
  });
});
