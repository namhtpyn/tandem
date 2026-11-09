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

import {
  mockDb,
  taskMessages as dbTaskMessages,
  taskReviews as dbTaskReviews,
  taskRuns,
  taskStatuses as dbTaskStatuses,
  tasks as dbTasks,
} from './helpers/mock-db';

const h = vi.hoisted(() => ({
  taskStatus: '' as string,
  taskFlips: [] as string[],
  trackTaskStatusOnFlip: false,
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
  /** the departing holder's pending ANSWER obligations (#369): select({id, taskId}) */
  answerObligationSelect: [] as Array<{ id: string; taskId: string }>,
  /** orphan ANSWER obligations seen by the sweeping scans (#369): select({taskId}) */
  answerLeftoverSelect: [] as Array<{ taskId: string }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; cond: unknown }>,
  deletes: [] as Array<{ table: string; cond: unknown }>,
  cancelled: [] as string[],
  cancelledAll: [] as string[],
  deletedById: [] as string[],
  resolved: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  regated: [] as string[],
  dispatches: [] as Array<Record<string, unknown>>,
  aiEmployees: [] as Array<{ userId: string }>,
  runningReviewRuns: [] as Array<{ id: string }>,
  statusReadThrows: 0,
  captureCond: null as unknown,
  runConds: [] as unknown[],
  joinConds: [] as Array<{ table: string; cond: unknown }>,
  stoppedRuns: [] as string[],
  holdDispatch: false,
  releaseDispatch: null as null | (() => void),
  published: 0,
  flipWins: true,
  casMiss: false,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskObligations, taskRuns } = await import('../../server/db/schema');
  const rowsThenable = (rows: () => Promise<Array<Record<string, unknown>>>) => {
    const mk = () => ({
      then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
        rows().then(ok, err),
      catch: (err: (e: unknown) => unknown) => rows().catch(err),
      orderBy: () => ({
        limit: async () => rows(),
        then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
          rows().then(ok, err),
        catch: (err: (e: unknown) => unknown) => rows().catch(err),
      }),
      limit: async () => rows(),
      innerJoin: () => mk(),
    });
    return mk();
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (arg?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const node: Record<string, unknown> = {};
          node.innerJoin = (joinTable: unknown, cond?: unknown) => {
            if (table === taskRuns) h.joinConds.push({ table: 'join', cond });
            return node;
          };
          node.where = (cond: unknown) =>
            rowsThenable(() => {
              const keys = arg ? Object.keys(arg) : [];
              if (table === tasks) {
                if (h.statusReadThrows > 0) {
                  h.statusReadThrows -= 1;
                  throw new Error('db down');
                }
                return Promise.resolve([{ status: h.taskStatus, updatedAt: h.taskUpdatedAt }]);
              }
              if (table === taskRuns) {
                h.captureCond = cond;
                h.runConds.push(cond);
                if (h.runsRequireReviewCategory) {
                  const cat = h.statuses.find((st) => st.id === h.taskStatus)?.category;
                  if (cat !== CATEGORY.IN_REVIEW) return Promise.resolve([]);
                }
                return Promise.resolve(h.runningReviewRuns);
              }
              if (table === taskObligations) {
                if (keys.includes('id') && keys.includes('taskId')) return Promise.resolve(h.answerObligationSelect);
                if (keys.includes('taskId')) return Promise.resolve(h.answerLeftoverSelect);
                return Promise.resolve(h.obligationSelect);
              }
              if (keys.includes('round')) return Promise.resolve([{ round: h.round }]);
              if (keys.includes('resultBody')) return Promise.resolve([{ resultBody: undefined }]);
              if (keys.includes('id') && keys.includes('taskId')) return Promise.resolve(h.pendingSelect);
              if (keys.includes('taskId')) return Promise.resolve(h.leftoverSelect);
              return Promise.resolve(h.reviewReads.shift() ?? []);
            });
          return node;
        },
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
              if (table === tasks) {
                if (h.flipWins && typeof set.status === 'string') {
                  h.taskFlips.push(set.status);
                  if (h.trackTaskStatusOnFlip) h.taskStatus = set.status;
                }
                return h.flipWins ? [{ id: 'task-1' }] : [];
              }
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
        aiEmployees: { findMany: async () => h.aiEmployees },
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
  dispatchTask: async (...args: unknown[]) => {
    h.dispatches.push(args[2] as Record<string, unknown>);
    if (h.holdDispatch) await new Promise<void>((resolve) => (h.releaseDispatch = resolve));
  },
  stopRunsForRemoval: async (ids: string[]) => {
    h.stoppedRuns.push(...ids);
    h.runningReviewRuns = h.runningReviewRuns.filter((r) => !ids.includes(r.id));
    return ids.length;
  },
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async (taskId: string) => {
    h.regated.push(taskId);
  },
}));

import {
  dispatchAiReviewTurns,
  openRoundLive,
  prepareReviewerRemoval,
  recordVerdict,
  runningReviewRunIdsForEmployee,
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
  h.taskFlips = [];
  h.trackTaskStatusOnFlip = false;
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
  h.answerObligationSelect = [];
  h.answerLeftoverSelect = [];
  h.updates = [];
  h.deletes = [];
  h.cancelled = [];
  h.cancelledAll = [];
  h.deletedById = [];
  h.resolved = [];
  h.notes = [];
  h.regated = [];
  h.dispatches = [];
  h.aiEmployees = [];
  h.runningReviewRuns = [];
  h.statusReadThrows = 0;
  h.captureCond = null;
  h.runConds = [];
  h.joinConds = [];
  h.stoppedRuns = [];
  h.holdDispatch = false;
  h.releaseDispatch = null;
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
    // the flip leaves BLOCKED, so the park ladder is inert — a settled round must not
    // hand a spent ladder to the task's next park (#365 r6)
    expect(h.updates.find((u) => u.table === 'tasks')?.set.parkRearmAfter).toBeNull();
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
      answerObligations: [],
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
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
    ];
    const settled = await settleReviewerRemovalRounds(
      {
        taskIds: ['task-1', 'task-2'],
        reviewRowIds: ['row-1', 'row-3'],
        obligationIds: ['ob-1', 'ob-2'],
        answerObligations: [],
      },
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

  it('notes the removed reviewer rows BEFORE the answer arm can settle them away (#369)', async () => {
    h.taskStatus = STATUS.waitingAnswer;
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    h.pendingSelect = [{ id: 'row-1', taskId: 'task-1' }];
    await settleReviewerRemovalRounds({
      taskIds: [],
      reviewRowIds: ['row-1'],
      obligationIds: [],
      answerObligations: [{ id: 'ans-1', taskId: 'task-1' }],
    });
    const noteIdx = h.updates.findIndex((u) => u.table === 'taskReviews' && typeof u.set.note === 'string');
    const flipIdx = h.updates.findIndex((u) => u.table === 'tasks');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(flipIdx).toBeGreaterThan(noteIdx);
  });

  it('settle half also picks up a leftover void row from an earlier removal/race', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]];
    const settled = await settleReviewerRemovalRounds({
      taskIds: [],
      reviewRowIds: [],
      obligationIds: [],
      answerObligations: [],
    });
    expect(settled).toEqual(['task-9']);
    expect(h.updates.find((u) => u.table === 'tasks' && u.set.status === STATUS.todo)).toBeTruthy();
  });

  it('the boot heal settles every leftover void round', async () => {
    h.leftoverSelect = [{ taskId: 'task-1' }, { taskId: 'task-1' }, { taskId: 'task-2' }];
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
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
    expect(
      await settleReviewerRemovalRounds({ taskIds: [], reviewRowIds: [], obligationIds: [], answerObligations: [] }),
    ).toEqual([]);
    const drop = h.deletes.find((d) => d.table === 'taskObligations');
    expect(drop).toBeTruthy();
    expect(renderCond(drop?.cond)).toContain('"employee_id" is null');
  });

  it('a BLOCKED task keeps its current-round void row — the unblock needs the signature (#365 r4)', async () => {
    h.taskStatus = STATUS.todo;
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: null }]]; // settle no-ops: not in review
    await settleReviewerRemovalRounds({ taskIds: [], reviewRowIds: [], obligationIds: [], answerObligations: [] });
    const debris = h.updates.find((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    // stale-round only: the current round's void row is the machine signature and
    // must survive every status (a blocked/parked round settles on unblock)
    expect(renderCond(debris?.cond)).toContain('"round" <');
  });

  it('a settled task left with a void row by a crashed settle is healed on the next trigger (#365 r5)', async () => {
    // the flip is the FIRST write: a crash before the teardown leaves a done task
    // still carrying the void row + its siblings' pending approvals, and the debris
    // sweep deliberately never clears a current-round row — the terminal arm heals it
    h.statuses = [{ id: 'st-done', category: CATEGORY.DONE }];
    h.taskStatus = 'st-done';
    expect(await settleExtinguishedRound('task-1')).toBe(false);
    expect(h.updates.some((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED)).toBe(true);
    expect(h.cancelled).toEqual(['task-1']); // pending approvals cancelled with the residue
    expect(h.updates.some((u) => u.table === 'tasks')).toBe(false); // never a second flip
  });
});

describe('removal resumes the sequential review queue (#371)', () => {
  it('a removal that leaves a live AI reviewer mints the next turn', async () => {
    // settle half: the round has a live voter (ai-2), so the extinguished-round
    // matrix no-ops — but nothing is in flight (the removed reviewer owned the
    // sequential turn), so the removal itself must mint ai-2's turn.
    h.leftoverSelect = [];
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }], // settleExtinguishedRound: live voter, no void row -> false
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }], // openRoundLive
      [
        // dispatchAiReviewTurns: the departing reviewer's void row, then the live AI
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
        { status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' },
      ],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    const settled = await settleReviewerRemovalRounds({
      taskIds: ['task-1'],
      reviewRowIds: ['row-void'],
      obligationIds: [],
      answerObligations: [],
    });
    expect(settled).toEqual([]);
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]).toMatchObject({ reviewBy: 'ai-2', verdictCorrection: false });
  });

  it('a human-only round mints nothing (no AI reviewer to run)', async () => {
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'human-1' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'human-1' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'human-1' }],
    ];
    h.aiEmployees = [];
    await settleReviewerRemovalRounds({
      taskIds: ['task-1'],
      reviewRowIds: [],
      obligationIds: [],
      answerObligations: [],
    });
    expect(h.dispatches).toHaveLength(0);
  });

  it('a settled task mints nothing', async () => {
    h.taskStatus = STATUS.done;
    h.reviewReads = [];
    await settleReviewerRemovalRounds({
      taskIds: ['task-1'],
      reviewRowIds: [],
      obligationIds: [],
      answerObligations: [],
    });
    expect(h.dispatches).toHaveLength(0);
  });
});

describe('removal run capture (#370)', () => {
  it('captures the departing reviewer’s RUNNING review turns and pins the SQL predicate', async () => {
    h.runningReviewRuns = [{ id: 'run-1' }, { id: 'run-2' }];
    expect(await runningReviewRunIdsForEmployee('emp-1')).toEqual(['run-1', 'run-2']);
    // render the FULL capture query — WHERE + all four joins — through real drizzle
    const { sql, params } = mockDb()
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .innerJoin(dbTaskMessages, h.joinConds[0]!.cond as never)
      .innerJoin(dbTasks, h.joinConds[1]!.cond as never)
      .innerJoin(dbTaskStatuses, h.joinConds[2]!.cond as never)
      .innerJoin(dbTaskReviews, h.joinConds[3]!.cond as never)
      .where(h.captureCond as never)
      .toSQL();
    const rendered = `${sql} ${JSON.stringify(params)}`;
    expect(h.joinConds).toHaveLength(4);
    // the employee id + RUNNING status ride the WHERE (a stray capture of every
    // employee's runs would stop unrelated in-flight turns)
    expect(rendered).toContain('"employee_id" =');
    expect(rendered).toContain('emp-1');
    expect(rendered).toContain('"status" =');
    expect(rendered).toContain('RUNNING');
    // the review-vs-work discriminator: only an in_review-category task qualifies
    expect(rendered).toContain('"task_statuses"."category" =');
    expect(rendered).toContain('in_review');
    // …and the run must carry a PENDING review row naming the same reviewer
    expect(rendered).toContain('"task_reviews"."reviewer_id" =');
    expect(rendered).toContain('"task_reviews"."status" =');
    expect(rendered).toContain('PENDING');
  });
});

describe('removal resume guards (#371)', () => {
  const liveOnly = { taskIds: ['task-1'], reviewRowIds: [], obligationIds: [], answerObligations: [] };

  it('a CUSTOM in-review-category status still resumes (category gate, never a seeded id)', async () => {
    h.statuses = [
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
      { id: STATUS.done, category: CATEGORY.DONE },
    ];
    h.taskStatus = 'st-custom-review';
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    await settleReviewerRemovalRounds(liveOnly);
    expect(h.dispatches).toHaveLength(1);
  });

  it('a live sibling turn suppresses the mint (task-wide sequential, #371 r1)', async () => {
    // another reviewer's turn is still in flight — the removal must NOT dispatch
    // an additional reviewer beside it
    h.runningReviewRuns = [{ id: 'run-live' }];
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      // if the in-flight guard were deleted, the dispatch row read would mint here
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    await settleReviewerRemovalRounds(liveOnly);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a settled task mints nothing even with a live pending AI row', async () => {
    h.taskStatus = STATUS.done;
    h.statuses = [{ id: STATUS.done, category: CATEGORY.DONE }];
    // if the category gate were deleted, openRoundLive + dispatch would see these
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    await settleReviewerRemovalRounds(liveOnly);
    expect(h.dispatches).toHaveLength(0);
  });

  it('one dispatch per affected task (two eligible tasks -> two dispatches)', async () => {
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    await settleReviewerRemovalRounds({ ...liveOnly, taskIds: ['task-1', 'task-2'] });
    expect(h.dispatches).toHaveLength(2);
  });

  it('boot resume re-mints a live round left by a crashed removal (#371 crash backstop)', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
        { status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' },
      ],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    expect(await settleAllExtinguishedRounds()).toEqual([]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('boot settles the FK-orphaned RUNNING row before it resumes (#371 delete→stop crash window)', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.runningReviewRuns = [{ id: 'run-zombie-9' }];
    h.reviewReads = [
      [
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
        { status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' },
      ],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    expect(await settleAllExtinguishedRounds()).toEqual([]);
    expect(h.stoppedRuns).toEqual(['run-zombie-9']);
    expect(h.dispatches).toHaveLength(1);
    // the orphan scan must be NULL-holder + RUNNING + review-category scoped — a
    // looser WHERE would stop a deleted assignee��s WORK run (skipping its bounce)
    const orphan = h.runConds
      .map((cond) =>
        mockDb()
          .select()
          .from(taskRuns)
          .where(cond as never)
          .toSQL(),
      )
      .find((q) => q.sql.includes('employee_id') && q.sql.includes('is null'));
    expect(orphan).toBeTruthy();
    expect(orphan!.sql).toContain('"employee_id" is null');
    expect(orphan!.sql).toContain('"task_statuses"."category" =');
    expect(orphan!.params).toContain('in_review');
    expect(orphan!.params).toContain('task-9');
  });

  it('boot stops the orphan BEFORE the sole-void settle leaves the review category (#370 r4 order)', async () => {
    h.leftoverSelect = [{ taskId: 'task-9' }];
    h.runningReviewRuns = [{ id: 'run-zombie-9' }];
    h.runsRequireReviewCategory = true; // the scan honors the category predicate
    h.trackTaskStatusOnFlip = true; // the flip really moves the mocked task out of review
    // sole-void round: the only row is the FK-nulled PENDING one -> settle flips the task
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: null }],
    ];
    await settleAllExtinguishedRounds();
    // the stop scan only matches while the task is still in the review category, so a
    // stop running AFTER the settle flip would find nothing here
    expect(h.stoppedRuns).toEqual(['run-zombie-9']);
    expect(h.taskFlips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('the in-flight guard is task-scoped and RUNNING-only (#371 predicate pin)', async () => {
    h.reviewReads = [[{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }]];
    h.aiEmployees = [{ userId: 'ai-2' }];
    h.holdDispatch = true;
    const pending = dispatchAiReviewTurns('task-9');
    await vi.waitFor(() => {
      if (!h.releaseDispatch) throw new Error('dispatch not reached yet');
    });
    const { sql, params } = mockDb()
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .innerJoin(dbTaskMessages, h.joinConds[0]!.cond as never)
      .where(h.captureCond as never)
      .toSQL();
    expect(sql).toContain('"task_messages"."task_id"');
    expect(params).toContain('task-9');
    expect(params).toContain('RUNNING');
    h.releaseDispatch!();
    await pending;
  });

  it('concurrent mint triggers on one task never double-dispatch (per-task mint lock)', async () => {
    h.holdDispatch = true;
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      // without the lock the second trigger would read this row and dispatch too
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    const first = dispatchAiReviewTurns('task-1');
    await vi.waitFor(() => {
      if (!h.releaseDispatch) throw new Error('dispatch not reached yet');
    });
    // the second trigger returns at the lock without reading or dispatching
    await dispatchAiReviewTurns('task-1');
    h.releaseDispatch!();
    await first;
    expect(h.dispatches).toHaveLength(1);
  });

  it('a resume read failure is fault-isolated: the next task still resumes', async () => {
    // task-1's settle read throws, then its resume status read throws; task-2 proceeds
    h.statusReadThrows = 2;
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'ai-2' }],
    ];
    h.aiEmployees = [{ userId: 'ai-2' }];
    await expect(settleReviewerRemovalRounds({ ...liveOnly, taskIds: ['task-1', 'task-2'] })).resolves.toEqual([]);
    expect(h.dispatches).toHaveLength(1);
  });
});
