// REVIEWER REMOVAL (#365): task_reviews.reviewer_id is `on delete set null`, so an
// employee deleted while holding a PENDING review row leaves a row no one can vote
// on — settle-waiting forever. A PENDING row with a NULL reviewer is a NON-VOTE: it
// never reads as live, it never blocks a settle, and a round left with no live voter
// settles by the normal matrix without the verdict that can never arrive. The void
// row itself is the discriminator (no legal write path mints one), so a manual move
// to in-review over an already-decided round is never stomped.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskStatus: '' as string,
  statuses: [] as Array<{ id: string; category: string }>,
  round: 2,
  /** queue of rows served to bare `select().from(taskReviews)` reads, in order */
  reviewReads: [] as Array<Array<Record<string, unknown>>>,
  /** rows served to `select({taskId}).from(taskReviews)` (prepareReviewerRemoval) */
  pendingSelect: [] as Array<{ taskId: string }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  cancelled: [] as string[],
  cancelledAll: [] as string[],
  cancelledEmployee: [] as string[],
  resolved: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  published: 0,
  flipWins: true,
  casMiss: false,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (arg?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const shape = arg
            ? 'round' in arg
              ? 'round'
              : 'taskId' in arg
                ? 'taskId'
                : 'resultBody' in arg
                  ? 'body'
                  : 'bare'
            : 'bare';
          const rows = () => {
            if (table === tasks) return Promise.resolve([{ status: h.taskStatus }]);
            if (shape === 'round') return Promise.resolve([{ round: h.round }]);
            if (shape === 'taskId') return Promise.resolve(h.pendingSelect);
            if (shape === 'body') return Promise.resolve([{ resultBody: undefined }]);
            return Promise.resolve(h.reviewReads.shift() ?? []);
          };
          const mk = () => ({
            then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
              rows().then(ok, err),
            catch: (err: (e: unknown) => unknown) => rows().catch(err),
            orderBy: () => ({ limit: async () => rows() }),
            limit: async () => rows(),
            innerJoin: () => mk(),
          });
          return { where: () => mk(), innerJoin: () => mk() };
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => {
            const applied = () => {
              h.updates.push({
                table: table === tasks ? 'tasks' : table === taskReviews ? 'taskReviews' : 'other',
                set,
              });
              if (table === tasks) return h.flipWins ? [{ id: 'task-1' }] : [];
              // the VERDICT CAS (.returning on a status write) is the only review
              // update that can miss; supersede/note writes always land
              const isVerdictCas =
                set.status !== undefined && set.status !== REVIEW_STATUS.SUPERSEDED && set.decidedAt !== undefined;
              if (isVerdictCas) return h.casMiss ? [] : [{ id: 'row-1' }];
              return [{ id: 'row-1' }];
            };
            return {
              then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
                Promise.resolve(applied()).then(ok, err),
              catch: (err: (e: unknown) => unknown) => Promise.resolve(applied()).catch(err),
              returning: async () => applied(),
            };
          },
        }),
      }),
      query: {
        taskStatuses: { findMany: async () => h.statuses },
        aiEmployees: { findMany: async () => [] },
        user: { findMany: async () => [] },
      },
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string; payload: Record<string, unknown> }) => {
      h.notes.push({ body: args.body, payload: args.payload });
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async () => {
      h.published += 1;
    },
  };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    resolveObligation: async (...args: unknown[]) => {
      h.resolved.push(String(args[1]));
    },
    cancelObligations: async (...args: unknown[]) => {
      h.cancelled.push(String(args[0]));
    },
    cancelAllObligations: async (...args: unknown[]) => {
      h.cancelledAll.push(String(args[0]));
    },
    cancelEmployeeObligations: async (...args: unknown[]) => {
      h.cancelledEmployee.push(`${String(args[0])}:${String(args[1])}`);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
}));

import {
  openRoundLive,
  prepareReviewerRemoval,
  recordVerdict,
  settleExtinguishedRound,
  settleReviewerRemovalRounds,
} from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskStatus = STATUS.inReview;
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
    { id: STATUS.cancelled, category: CATEGORY.CANCELLED },
  ];
  h.round = 2;
  h.reviewReads = [];
  h.pendingSelect = [];
  h.updates = [];
  h.cancelled = [];
  h.cancelledAll = [];
  h.cancelledEmployee = [];
  h.resolved = [];
  h.notes = [];
  h.published = 0;
  h.flipWins = true;
  h.casMiss = false;
});

describe('void pending rows are non-votes (#365)', () => {
  it('openRoundLive: a NULL-reviewer pending row is never live', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    expect(await openRoundLive('task-1')).toBe(false);
  });

  it('openRoundLive: a real pending reviewer still counts', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }]];
    expect(await openRoundLive('task-1')).toBe(true);
  });

  it('a surviving reviewer’s verdict settles the round despite a deleted sibling (NULL pending row)', async () => {
    h.reviewReads = [
      [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }], // recordVerdict's row
      [
        { status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' }, // the just-written verdict
        { status: REVIEW_STATUS.PENDING, reviewerId: null }, // deleted reviewer — void non-vote
      ], // settleRound's fresh read
    ];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.done);
    // the void row is extinguished, never left PENDING on a closed round
    expect(h.updates.some((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED)).toBe(true);
  });
});

describe('settleExtinguishedRound (#365)', () => {
  it('a round with only a deleted reviewer bounces back to the assignee instead of wedging', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    expect(await settleExtinguishedRound('task-1')).toBe(true);
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.todo);
    expect(h.cancelledAll).toEqual(['task-1']);
    expect(h.notes.at(-1)?.body).toContain('no reviewers remain');
  });

  it('a deleted reviewer plus decided approvals still completes the task', async () => {
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
      ],
    ];
    expect(await settleExtinguishedRound('task-1')).toBe(true);
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.done);
    expect(h.cancelled).toEqual(['task-1']);
  });

  it('a deleted reviewer plus a decided rejection cancels the task', async () => {
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.REJECTED, reviewerId: 'rev-1' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
      ],
    ];
    expect(await settleExtinguishedRound('task-1')).toBe(true);
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.cancelled);
  });

  it('a live reviewer still owns the round — nothing settles under them', async () => {
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.PENDING, reviewerId: 'rev-2' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
      ],
    ];
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('a decided round with no void row is a legal manual state — never stomped', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' }]];
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('a task outside the in-review category is never touched', async () => {
    h.taskStatus = STATUS.todo;
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('a lost flip (concurrent settle/move) writes no note and reports false', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    h.flipWins = false;
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.notes).toHaveLength(0);
  });
});

describe('employee removal prepare half (#365)', () => {
  it('notes the departing reviewer’s pending rows and cancels only THEIR obligations', async () => {
    h.pendingSelect = [{ taskId: 'task-1' }, { taskId: 'task-1' }, { taskId: 'task-2' }];
    const taskIds = await prepareReviewerRemoval('emp-1', 'Ada');
    expect(taskIds).toEqual(['task-1', 'task-2']);
    const note = h.updates.find((u) => u.table === 'taskReviews' && typeof u.set.note === 'string');
    expect(note?.set.note).toContain('Ada');
    expect(h.cancelledEmployee).toEqual(['task-1:emp-1', 'task-2:emp-1']);
  });

  it('no pending rows = no work at all', async () => {
    h.pendingSelect = [];
    expect(await prepareReviewerRemoval('emp-1', 'Ada')).toEqual([]);
    expect(h.updates).toHaveLength(0);
    expect(h.cancelledEmployee).toHaveLength(0);
  });

  it('settleReviewerRemovalRounds settles every affected round', async () => {
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
    ];
    expect(await settleReviewerRemovalRounds(['task-1', 'task-2'])).toBe(2);
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(2);
  });
});
