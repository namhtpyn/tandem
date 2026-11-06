// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): a manual owner move back into an
// in-review-CATEGORY status with a live round re-dispatches the parked reviewer.
// The seeded-id version silently skipped a custom in-review target — the owner's
// unblock parked nothing back to life and the round wedged with a PENDING row and
// no run (no probe shape catches it: the wedge arm requires zero PENDING rows).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';

const h = vi.hoisted(() => ({
  statuses: [] as Array<{ id: string; category: string }>,
  live: false,
  dispatched: [] as string[],
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      // honor the caller's predicate (DB-mock predicate law): a mis-wired where
      // must FAIL the test, never be masked by an unfiltered mock
      taskStatuses: {
        findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
          const id = args?.where?.id?.eq;
          return id ? h.statuses.filter((s) => s.id === id) : h.statuses;
        },
      },
    },
  },
}));

vi.mock('../../server/domains/tasks/review.service', () => ({
  openRoundLive: async () => h.live,
  dispatchAiReviewTurns: async (taskId: string) => void h.dispatched.push(taskId),
}));

import { resumeRoundAfterManualMove } from '../../server/domains/tasks/review-resume';

beforeEach(() => {
  h.statuses = [];
  h.live = false;
  h.dispatched = [];
});

describe('unblock-resume keys off the target status CATEGORY (#336)', () => {
  it('a custom IN-REVIEW-category target with a live round re-fires the reviewer', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('the seeded in-review status still re-fires (no regression)', async () => {
    h.statuses = [{ id: 'seeded-review', category: CATEGORY.IN_REVIEW }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'seeded-review')).toBe(true);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('a WORKING-category target never re-fires a reviewer — the owner resolved it', async () => {
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-doing')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('an in-review target with NO live round dispatches nothing', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('a dangling target status id is dead input — no dispatch, no guess', async () => {
    h.statuses = [];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-legacy-dangling')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});
