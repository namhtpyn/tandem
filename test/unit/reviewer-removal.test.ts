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

import { mockDb, taskReviews as dbTaskReviews } from './helpers/mock-db';

const h = vi.hoisted(() => ({
  taskStatus: '' as string,
  statuses: [] as Array<{ id: string; category: string }>,
  round: 2,
  taskUpdatedAt: new Date('2026-11-08T00:00:00Z'),
  /** queue of rows served to bare `select().from(taskReviews)` reads, in order */
  reviewReads: [] as Array<Array<Record<string, unknown>>>,
  /** pending rows for prepareReviewerRemoval: select({id, taskId}) */
  pendingSelect: [] as Array<{ id: string; taskId: string }>,
  /** leftover void-row task ids: select({taskId}) */
  leftoverSelect: [] as Array<{ taskId: string }>,
  /** the departing reviewer's pending APPROVAL obligations: select({id}) from taskObligations */
  obligationSelect: [] as Array<{ id: string }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; cond: unknown }>,
  deletes: [] as Array<{ table: string; cond: unknown }>,
  cancelled: [] as string[],
  cancelledAll: [] as string[],
  deletedById: [] as string[],
  resolved: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  regated: [] as string[],
  published: 0,
  flipWins: true,
  casMiss: false,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskObligations } = await import('../../server/db/schema');
  const rowsThenable = (rows: () => Promise<Array<Record<string, unknown>>>) => {
    const mk = () => ({
      then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
        rows().then(ok, err),
      catch: (err: (e: unknown) => unknown) => rows().catch(err),
      orderBy: () => ({ limit: async () => rows() }),
      limit: async () => rows(),
      innerJoin: () => mk(),
    });
    return mk();
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (arg?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (cond: unknown) =>
            rowsThenable(() => {
              const keys = arg ? Object.keys(arg) : [];
              if (table === tasks) return Promise.resolve([{ status: h.taskStatus, updatedAt: h.taskUpdatedAt }]);
              if (table === taskObligations) return Promise.resolve(h.obligationSelect);
              if (keys.includes('round')) return Promise.resolve([{ round: h.round }]);
              if (keys.includes('resultBody')) return Promise.resolve([{ resultBody: undefined }]);
              if (keys.includes('id') && keys.includes('taskId')) return Promise.resolve(h.pendingSelect);
              if (keys.includes('taskId')) return Promise.resolve(h.leftoverSelect);
              return Promise.resolve(h.reviewReads.shift() ?? []);
            }),
          innerJoin: () => rowsThenable(async () => []),
        }),
      }),
      delete: (table: unknown) => ({
        where: (cond: unknown) => {
          h.deletes.push({ table: table === taskObligations ? 'taskObligations' : 'other', cond });
          return Promise.resolve([]);
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const applied = () => {
              h.updates.push({
                table:
                  table === tasks
                    ? 'tasks'
                    : table === taskReviews
                      ? 'taskReviews'
                      : table === taskObligations
                        ? 'taskObligations'
                        : 'other',
                set,
                cond,
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
    deleteObligationById: async (id: string) => {
      h.deletedById.push(id);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async (taskId: string) => {
    h.regated.push(taskId);
  },
}));

import {
  openRoundLive,
  prepareReviewerRemoval,
  recordVerdict,
  settleAllExtinguishedRounds,
  settleExtinguishedRound,
  settleReviewerRemovalRounds,
} from '../../server/domains/tasks/review.service';

/** render a captured drizzle condition to SQL + params (DB-mock predicate law: pin the
 * predicate by RENDERING it, never by a presence check) */
function renderCond(cond: unknown): string {
  const q = mockDb()
    .select()
    .from(dbTaskReviews)
    .where(cond as never)
    .toSQL();
  return `${q.sql} ${JSON.stringify(q.params)}`;
}

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
  h.leftoverSelect = [];
  h.obligationSelect = [];
  h.updates = [];
  h.deletes = [];
  h.cancelled = [];
  h.cancelledAll = [];
  h.deletedById = [];
  h.resolved = [];
  h.notes = [];
  h.regated = [];
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
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.todo);
    // the flip pins the status AND updatedAt it read (TERMINAL ARBITRATION, #292 r2)
    const flipSql = renderCond(flip?.cond);
    expect(flipSql).toContain('"status" =');
    expect(flipSql).toContain('"updated_at" =');
    expect(h.cancelledAll).toEqual(['task-1']);
    expect(h.notes.at(-1)?.body).toContain('no reviewers remain');
    // a bounce is NOT terminal: no parent re-gate (the task stays open)
    expect(h.regated).toEqual([]);
  });

  it('a deleted reviewer plus decided approvals still completes the task — and closes every pending row', async () => {
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
      ],
    ];
    expect(await settleExtinguishedRound('task-1')).toBe(true);
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.done);
    // terminal arm: task-wide supersede of every pending row (all rounds); the approved
    // round keeps its FULFILLED approvals (matrix parity with settleRound)
    const sweeps = h.updates.filter((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    expect(sweeps.length).toBeGreaterThanOrEqual(2);
    expect(h.cancelled).toEqual(['task-1']);
    expect(h.cancelledAll).toEqual([]);
    // a TERMINAL settle re-gates the task's parents (an auto-blocked parent unblocks)
    expect(h.regated).toEqual(['task-1']);
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

  it('the void-row sweep is SCOPED: reviewer_id IS NULL, this task, this round, pending only', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    await settleExtinguishedRound('task-1');
    const sweep = h.updates.find(
      (u) =>
        u.table === 'taskReviews' &&
        u.set.status === REVIEW_STATUS.SUPERSEDED &&
        renderCond(u.cond).includes('reviewer_id'),
    );
    const sql = renderCond(sweep?.cond);
    expect(sql).toContain('"reviewer_id" is null');
    expect(sql).toContain('"task_id" =');
    expect(sql).toContain('"round" =');
    expect(sql).toContain('"status" =');
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

  it('a lost flip (concurrent settle/move) leaves the void row intact — the next trigger can still heal', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    h.flipWins = false;
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.notes).toHaveLength(0);
    // FLIP-FIRST: the machine signature (the void pending row) is only extinguished
    // after a WON flip, so a lost CAS never strands an unhealable in-review round
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(1);
    expect(
      h.updates.filter((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED),
    ).toHaveLength(0);
  });
});

describe('employee removal halves (#365)', () => {
  it('prepare is READ-ONLY and captures rows + obligations', async () => {
    h.pendingSelect = [
      { id: 'row-1', taskId: 'task-1' },
      { id: 'row-2', taskId: 'task-1' },
      { id: 'row-3', taskId: 'task-2' },
    ];
    h.obligationSelect = [{ id: 'ob-1' }, { id: 'ob-2' }];
    const plan = await prepareReviewerRemoval('emp-1');
    expect(plan).toEqual({
      taskIds: ['task-1', 'task-2'],
      reviewRowIds: ['row-1', 'row-2', 'row-3'],
      obligationIds: ['ob-1', 'ob-2'],
    });
    // a failed delete must change nothing: no writes in the capture half
    expect(h.updates).toHaveLength(0);
    expect(h.deletedById).toHaveLength(0);
  });

  it('settle half cancels the captured obligations, notes the captured rows, and settles every round', async () => {
    h.leftoverSelect = [];
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
    ];
    const settled = await settleReviewerRemovalRounds(
      { taskIds: ['task-1', 'task-2'], reviewRowIds: ['row-1', 'row-3'], obligationIds: ['ob-1', 'ob-2'] },
      'Ada',
    );
    expect(settled).toEqual(['task-1', 'task-2']);
    expect(h.deletedById).toEqual(['ob-1', 'ob-2']);
    const note = h.updates.find((u) => u.table === 'taskReviews' && typeof u.set.note === 'string');
    expect(note?.set.note).toContain('Ada');
    // the note is scoped to the captured row ids, never a reviewer-wide sweep
    const sql = renderCond(note?.cond);
    expect(sql).toContain('"id" in');
    expect(sql).toContain('row-1');
    expect(sql).toContain('row-3');
    // …and only to rows still PENDING and now void — a verdict that landed in the
    // capture→delete window keeps its own note (never overwritten)
    expect(sql).toContain('"status" =');
    expect(sql).toContain('"reviewer_id" is null');
  });

  it('settle half also picks up a leftover void row from an earlier removal/race', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    const settled = await settleReviewerRemovalRounds({ taskIds: [], reviewRowIds: [], obligationIds: [] });
    expect(settled).toEqual(['task-9']);
    expect(h.updates.find((u) => u.table === 'tasks' && u.set.status === STATUS.todo)).toBeTruthy();
  });

  it('the boot heal settles every leftover void round', async () => {
    h.leftoverSelect = [{ taskId: 'task-1' }, { taskId: 'task-1' }, { taskId: 'task-2' }];
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
    ];
    expect(await settleAllExtinguishedRounds()).toEqual(['task-1', 'task-2']);
  });

  it('the removal sweep drops an orphaned null-holder approval obligation (round minted in the window)', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    // a live voter still owns the round: the settle no-ops, but the orphaned
    // obligation (holder nulled by the delete) must not keep counting forever —
    // DELETED, not cancelled (a cancelled row reads as a dead round to the tally)
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: 'rev-live' }]];
    expect(await settleReviewerRemovalRounds({ taskIds: [], reviewRowIds: [], obligationIds: [] })).toEqual([]);
    const drop = h.deletes.find((d) => d.table === 'taskObligations');
    expect(drop).toBeTruthy();
    expect(renderCond(drop?.cond)).toContain('"employee_id" is null');
  });

  it('a BLOCKED task keeps its current-round void row — the unblock needs the signature (#365 r4)', async () => {
    h.taskStatus = STATUS.todo;
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]]; // settle no-ops: not in review
    await settleReviewerRemovalRounds({ taskIds: [], reviewRowIds: [], obligationIds: [] });
    const debris = h.updates.find((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    // stale-round only: the current round's void row is the machine signature and
    // must survive every status (a blocked/parked round settles on unblock)
    expect(renderCond(debris?.cond)).toContain('"round" <');
  });
});
