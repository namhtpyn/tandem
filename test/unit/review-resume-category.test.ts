// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): a manual owner move back into an
// in-review-CATEGORY status with a live round re-dispatches the parked reviewer.
// The seeded-id version silently skipped a custom in-review target — the owner's
// unblock parked nothing back to life and the round wedged with a PENDING row and
// no run (no probe shape catches it: the wedge arm requires zero PENDING rows).
// REQUEUE HEAL (#440): the same move over a round that CANNOT decide — a decided
// round, or no round at all — opens a FRESH round on the stored roster (zero live
// reviewers completes exactly as if none were set), keeping the owner's chosen
// status id; a void round still settles by the matrix (#365) and the heal is
// fault-isolated.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  statuses: [] as Array<{ id: string; category: string }>,
  task: null as null | { status: string; updatedAt: Date; reviewers: string[] },
  live: false,
  dispatched: [] as string[],
  settled: [] as string[],
  settleResult: false,
  settleThrows: false,
  discarded: [] as string[],
  liveIds: [] as string[],
  opened: [] as Array<{
    taskId: string;
    reviewers: string[];
    body: string;
    flip: { status: string; updatedAt: Date };
    targetStatus?: string;
  }>,
  openResult: { flipped: false, round: 0, opened: 0, dropped: [] as string[] },
  openThrows: false,
  torndown: [] as Array<[string, string]>,
  gated: [] as string[],
  doneFlip: [] as Array<Record<string, unknown>>,
  doneRows: [{ id: 'task-1' }] as Array<{ id: string }>,
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
      tasks: {
        findFirst: async () => h.task,
      },
    },
    update: (_table: unknown) => ({
      set: (payload: Record<string, unknown>) => ({
        where: (_w: unknown) => ({
          returning: async () => {
            h.doneFlip.push(payload);
            return h.doneRows;
          },
        }),
      }),
    }),
  },
}));

vi.mock('../../server/domains/tasks/review.service', () => ({
  openRoundLive: async () => h.live,
  dispatchAiReviewTurns: async (taskId: string) => void h.dispatched.push(taskId),
  // #365: a not-live landing is offered to the extinguished-round settle (it no-ops
  // on round-0 / decided rounds — the void-row discriminator lives in the service)
  settleExtinguishedRound: async (taskId: string) => {
    h.settled.push(taskId);
    if (h.settleThrows) throw new Error('settle boom');
    return h.settleResult;
  },
  // #365 r5: an owner reopen discards the stale void rows so later heals never
  // auto-settle the reopen
  discardVoidRows: async (taskId: string) => void h.discarded.push(taskId),
  // #440 heal deps: existence re-check + the round-open + the zero-survivor teardown
  liveReviewers: async (reviewers: string[]) => reviewers.filter((id) => h.liveIds.includes(id)),
  openReviewRound: async (
    taskId: string,
    reviewers: string[],
    body: string,
    flip: { status: string; updatedAt: Date },
    targetStatus?: string,
  ) => {
    h.opened.push({ taskId, reviewers, body, flip, targetStatus });
    if (h.openThrows) throw new Error('round-open boom');
    return h.openResult;
  },
  teardownAllPendingRounds: async (taskId: string, reason: string) => void h.torndown.push([taskId, reason]),
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async (taskId: string) => void h.gated.push(taskId),
}));

import { resumeRoundAfterManualMove } from '../../server/domains/tasks/review-resume';

const T0 = new Date('2026-11-13T00:00:00Z');

beforeEach(() => {
  h.statuses = [];
  h.task = null;
  h.live = false;
  h.dispatched = [];
  h.settled = [];
  h.settleResult = false;
  h.settleThrows = false;
  h.discarded = [];
  h.liveIds = [];
  h.opened = [];
  h.openResult = { flipped: false, round: 0, opened: 0, dropped: [] };
  h.openThrows = false;
  h.torndown = [];
  h.gated = [];
  h.doneFlip = [];
  h.doneRows = [{ id: 'task-1' }];
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

  it('an in-review target with NO live round dispatches nothing — the extinguished-round settle gets the call', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.settled).toEqual(['task-1']);
  });

  it('reopening a SETTLED task (done -> in-review) is never auto-settled (#365 r4)', async () => {
    h.statuses = [
      { id: 'st-done', category: CATEGORY.DONE },
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
    ];
    h.live = false;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review', 'st-done')).toBe(false);
    expect(h.settled).toEqual([]);
    expect(h.discarded).toEqual(['task-1']); // the stale signature is voided too
  });

  it('a dangling target status id is dead input — no dispatch, no guess', async () => {
    h.statuses = [];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-legacy-dangling')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe('requeue heal — a move into review over a round that cannot decide (#440)', () => {
  it('a DECIDED round requeued into review heals — fresh round on the stored roster, owner status kept', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = false; // decided round: the settle no-ops by design
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1', 'u-2'] };
    h.liveIds = ['u-1', 'u-2'];
    h.openResult = { flipped: true, round: 2, opened: 2, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.opened).toEqual([
      {
        taskId: 'task-1',
        reviewers: ['u-1', 'u-2'],
        body: '',
        flip: { status: 'st-custom-review', updatedAt: T0 },
        targetStatus: 'st-custom-review', // the OWNER'S chosen id, never the seeded one
      },
    ]);
    expect(h.dispatched).toEqual(['task-1']); // the reviewer turn rides the won flip
    expect(h.gated).toEqual(['task-1']); // parent gating first, dispatch second
    expect(h.doneFlip).toHaveLength(0); // no completion write raced the round
  });

  it('a NEVER-REVIEWED task (round 0) requeued into review heals the same way', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    h.openResult = { flipped: true, round: 1, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('the reopen door (done -> in-review) heals over a decided round too', async () => {
    h.statuses = [
      { id: 'st-done', category: CATEGORY.DONE },
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
    ];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review', 'st-done')).toBe(true);
    expect(h.discarded).toEqual(['task-1']); // void rows still discarded first
    expect(h.settled).toEqual([]); // and the reopen is still never auto-settled
    expect(h.opened).toHaveLength(1);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('an EMPTY roster completes exactly as if no reviewer were set — no round, no dispatch', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toEqual([{ status: STATUS.done, updatedAt: expect.any(Date) }]);
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
    expect(h.gated).toEqual(['task-1']);
  });

  it('a roster of only ABSENT reviewers completes the same way (existence re-checked)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-gone'] };
    h.liveIds = []; // the user no longer exists
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(1);
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
  });

  it('a VOID round still settles by the matrix — the heal never preempts it (#365)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = true; // void pending row: the matrix settles (done/cancel/todo)
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.settled).toEqual(['task-1']);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0); // the settle owned the outcome, not the heal
  });

  it('a settle FAILURE never heals — the void discriminator owns that shape', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleThrows = true;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
  });

  it('a lost flip arbitration is a quiet no-op — a concurrent writer owns the outcome', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    h.openResult = { flipped: false, round: 2, opened: 1, dropped: [] }; // CAS missed
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
    expect(h.torndown).toHaveLength(0);
  });

  it('the #364 window — every reviewer vanished inside the round-open tx completes the task', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    h.openResult = { flipped: false, round: 0, opened: 0, dropped: ['u-1'] }; // nothing minted, nothing flipped
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(1); // completed exactly as if none were set
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
  });

  it('a failed heal never fails the owner\u2019s move — fault isolation', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { status: 'st-custom-review', updatedAt: T0, reviewers: ['u-1'] };
    h.liveIds = ['u-1'];
    h.openThrows = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false); // no throw
    expect(h.dispatched).toHaveLength(0);
  });

  it('a task that vanished mid-heal is a quiet no-op', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = null; // deleted between the move and the heal
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
  });
});
