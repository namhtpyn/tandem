// #474 r5: the REQUEUE gate — an owner's move back to in-review must not open a FRESH
// round (minted from the stale roster the crashed handoff left behind) while the current
// round still owes a recorded referral's vote: that would bury the debt forever, because
// the handoff scan keys on the CURRENT round. The action heals the referral in the current
// round first; the round is then live and the requeue is unnecessary.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reviewReads: [] as Array<Array<Record<string, unknown>>>,
  round: 1,
}));

vi.mock('../../server/db/index', async () => {
  const { taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (arg?: Record<string, unknown>) => {
        const keys = Object.keys(arg ?? {});
        const node: Record<string, unknown> = {};
        const rows = () => {
          if (keys.includes('round')) return [{ round: h.round }];
          return h.reviewReads.shift() ?? [];
        };
        const p = () => Promise.resolve(rows());
        node.from = () => node;
        node.where = () => node;
        node.orderBy = () => node;
        node.limit = () => node;
        node.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => p().then(onF, onR);
        node.catch = (onR: (e: unknown) => unknown) => p().catch(onR);
        void taskReviews;
        return node;
      },
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', () => ({ insertActivityMessage: async () => ({ id: 'm' }) }));
vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
  replayLostSettle: async () => 'skipped',
}));
vi.mock('../../server/domains/kernel/kernel', () => ({ publishChange: async () => {} }));

const { currentRoundOwesReferral } = await import('../../server/domains/tasks/review.service');

describe('currentRoundOwesReferral (#474 requeue gate)', () => {
  it('is true while an escalated row records a target with no row in the current round', async () => {
    h.reviewReads = [
      [
        { status: 'APPROVED', reviewerId: 'rev-1', referralTargetId: null },
        { status: 'ESCALATED', reviewerId: 'rev-2', referralTargetId: 'rev-9' },
      ],
    ];
    expect(await currentRoundOwesReferral('task-1')).toBe(true);
  });

  it('is false once the recorded target has a row (satisfied) or no target was recorded', async () => {
    h.reviewReads = [
      [
        { status: 'ESCALATED', reviewerId: 'rev-2', referralTargetId: 'rev-9' },
        { status: 'PENDING', reviewerId: 'rev-9', referralTargetId: null },
      ],
    ];
    expect(await currentRoundOwesReferral('task-1')).toBe(false);
    h.reviewReads = [[{ status: 'ESCALATED', reviewerId: 'rev-2', referralTargetId: null }]];
    expect(await currentRoundOwesReferral('task-1')).toBe(false);
  });

  it('is false for a task with no round', async () => {
    h.round = 0;
    h.reviewReads = [];
    expect(await currentRoundOwesReferral('task-1')).toBe(false);
    h.round = 1;
  });
});
