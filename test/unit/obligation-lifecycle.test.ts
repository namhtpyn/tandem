// OBLIGATION LIFECYCLE (#205): a PENDING obligation must never outlive the
// state that makes it actionable. teardownOnManualMove resolves status
// CATEGORIES, never seeded ids — the old seeded-[done,cancelled] guard in
// setStatus skipped custom terminal statuses entirely, and teardownOpenRound's
// round===0 early-return left a question-flow task's ANSWER obligation PENDING
// forever (phantom inbox/badge/awaiting-decision rows with no detector).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, OBLIGATION_ROLE, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  statusRows: [] as Array<{ id: string; category: string }>,
  roundRows: [] as Array<{ round: number }>,
  reviewRows: [] as Array<{ id: string; status: string }>,
  updates: [] as Array<{ vals: Record<string, unknown> }>,
  cancelAllCalls: [] as Array<[string, string]>,
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskStatuses: {
        findMany: async () => h.statusRows,
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => h.roundRows }),
          then: (res: (v: Array<{ id: string; status: string }>) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(h.reviewRows).then(res, rej),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        h.updates.push({ vals });
        return { where: async () => {} };
      },
    }),
  },
}));

vi.mock('../../server/domains/tasks/obligations.service', () => ({
  spawnObligation: vi.fn(),
  cancelObligations: vi.fn(),
  cancelAllObligations: async (taskId: string, role: string) => {
    h.cancelAllCalls.push([taskId, role]);
  },
  resolveObligation: vi.fn(),
}));

vi.mock('../../server/domains/tasks/thread.service', () => ({
  insertActivityMessage: vi.fn(),
}));

vi.mock('../../server/domains/kernel/kernel', () => ({
  publishChange: vi.fn(),
}));

import { teardownOnManualMove } from '../../server/domains/tasks/review.service';

const SEEDED = [
  { id: STATUS.todo, category: CATEGORY.READY },
  { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
  { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
  { id: STATUS.done, category: CATEGORY.DONE },
  { id: STATUS.cancelled, category: CATEGORY.CANCELLED },
  { id: 'custom-done', category: CATEGORY.DONE },
  { id: 'custom-cancelled', category: CATEGORY.CANCELLED },
  { id: 'custom-wait', category: CATEGORY.WAITING_ANSWER },
  { id: 'custom-todo', category: CATEGORY.READY },
];

beforeEach(() => {
  h.statusRows = SEEDED;
  h.roundRows = [];
  h.reviewRows = [];
  h.updates = [];
  h.cancelAllCalls = [];
});

describe('teardownOnManualMove (obligation lifecycle #205)', () => {
  it('waiting-answer → seeded done, round 0: ANSWER obligation cancelled, no crash on empty round', async () => {
    await teardownOnManualMove('t1', STATUS.waitingAnswer, STATUS.done);
    expect(h.cancelAllCalls).toEqual([['t1', OBLIGATION_ROLE.ANSWER]]);
    expect(h.updates).toHaveLength(0);
  });

  it('waiting-answer → CUSTOM done-category status: settled, ANSWER obligation cancelled', async () => {
    await teardownOnManualMove('t1', 'custom-wait', 'custom-done');
    expect(h.cancelAllCalls).toEqual([['t1', OBLIGATION_ROLE.ANSWER]]);
    expect(h.updates).toHaveLength(0);
  });

  it('in_review → custom done-category status: round superseded + APPROVAL and ANSWER cancelled', async () => {
    h.roundRows = [{ round: 2 }];
    h.reviewRows = [{ id: 'r1', status: REVIEW_STATUS.PENDING }];
    await teardownOnManualMove('t1', STATUS.inReview, 'custom-done');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].vals.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.cancelAllCalls.sort()).toEqual([
      ['t1', OBLIGATION_ROLE.ANSWER],
      ['t1', OBLIGATION_ROLE.APPROVAL],
    ]);
  });

  it('waiting-answer → ready-category (not a settle): ANSWER obligation cancelled, round untouched', async () => {
    h.roundRows = [{ round: 1 }];
    await teardownOnManualMove('t1', STATUS.waitingAnswer, 'custom-todo');
    expect(h.cancelAllCalls).toEqual([['t1', OBLIGATION_ROLE.ANSWER]]);
    expect(h.updates).toHaveLength(0);
  });

  it('in_review → ready-category: no-op (round keeps living)', async () => {
    await teardownOnManualMove('t1', STATUS.inReview, 'custom-todo');
    expect(h.cancelAllCalls).toEqual([]);
    expect(h.updates).toHaveLength(0);
  });

  it('done-category → done-category (re-settle between custom terminal statuses): no-op', async () => {
    await teardownOnManualMove('t1', STATUS.done, 'custom-done');
    expect(h.cancelAllCalls).toEqual([]);
    expect(h.updates).toHaveLength(0);
  });

  it('seeded cancelled target: same settle semantics as done', async () => {
    h.roundRows = [{ round: 1 }];
    h.reviewRows = [{ id: 'r1', status: REVIEW_STATUS.PENDING }];
    await teardownOnManualMove('t1', 'custom-wait', STATUS.cancelled);
    expect(h.updates).toHaveLength(1);
    expect(h.cancelAllCalls.sort()).toEqual([
      ['t1', OBLIGATION_ROLE.ANSWER],
      ['t1', OBLIGATION_ROLE.APPROVAL],
    ]);
  });
});
