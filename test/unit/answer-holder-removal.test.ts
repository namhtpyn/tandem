// ANSWER-ROLE REMOVAL (#369): task_obligations.employee_id is `on delete set null`,
// so deleting the holder of a PENDING ANSWER obligation leaves the task in a
// waiting_answer status whose question nothing can answer, forward or abandon —
// stranded forever (and the company awaiting-decision queue counts it). Removal
// captures the departing holder's pending ANSWER rows read-only BEFORE the delete,
// cancels them by id AFTER it commits, and returns every affected task that lost
// its only holder to its flow: a live review round back to in-review (reviewer
// re-fires), anything else back to todo (question chain cleared, parents re-gated).
// A lost return flip touches nothing — the winner owns status AND obligations.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

import {
  mockDb,
  taskObligations as dbTaskObligations,
  taskReviews as dbTaskReviews,
  tasks as dbTasks,
} from './helpers/mock-db';

const h = vi.hoisted(() => ({
  /** the task row the return arm reads */
  taskStatus: '' as string,
  taskUpdatedAt: new Date('2026-11-08T00:00:00Z'),
  /** optional queue of task-row reads (status/updatedAt), consumed in order */
  taskReads: [] as Array<{ status: string; updatedAt: Date }>,
  /** throw on the Nth task-row read (1-based; 0 = never) */
  taskReadThrowOn: 0,
  /** how many task-row reads have happened */
  taskReadCount: 0,
  statuses: [] as Array<{ id: string; category: string }>,
  /** rows for the existential holder read: [{ employeeId }] */
  holderRows: [] as Array<{ employeeId: string | null }>,
  /** conditions captured from the existential holder read (predicate pin) */
  holderConds: [] as unknown[],
  /** conditions captured from the current-round pending-row read (round/status pin) */
  roundPendingConds: [] as unknown[],
  /** cancelOrphanAnswerObligations call args: [taskId, before] */
  orphanCalls: [] as Array<[string, Date | undefined]>,
  /** the departing holder's PENDING ANSWER obligations: select({id, taskId}) */
  answerObligationSelect: [] as Array<{ id: string; taskId: string }>,
  /** conditions captured from the ANSWER capture read (predicate pin) */
  answerConds: [] as unknown[],
  /** orphan ANSWER obligations (NULL holder) seen by the sweeping scans */
  answerLeftoverSelect: [] as Array<{ taskId: string }>,
  /** pending review rows for prepareReviewerRemoval */
  pendingSelect: [] as Array<{ id: string; taskId: string }>,
  /** make the void-review boot scan throw (fault-isolation pin) */
  voidScanThrows: false,
  /** mutation order log: 'flip' | 'cancelAll' | 'cancelById' */
  seq: [] as string[],
  /** leftover void review rows */
  leftoverSelect: [] as Array<{ taskId: string }>,
  /** bare select().from(taskReviews) reads, in order */
  reviewReads: [] as Array<Array<Record<string, unknown>>>,
  /** currentRoundHasPendingRow rows (select({id}) from taskReviews) */
  roundPending: [] as Array<Record<string, unknown>>,
  round: 0,
  aiEmployees: [] as Array<{ userId: string }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; cond: unknown }>,
  deletes: [] as Array<{ table: string; cond: unknown }>,
  cancelled: [] as string[],
  cancelledById: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  regated: [] as string[],
  dispatched: [] as string[],
  published: 0,
  flipWins: true,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskObligations, taskRuns } = await import('../../server/db/schema');
  const rowsThenable = (rows: () => Promise<Array<Record<string, unknown>>>) => {
    const mk = (): Record<string, unknown> => ({
      then: (ok?: (v: Array<Record<string, unknown>>) => unknown, err?: (e: unknown) => unknown) =>
        rows().then(ok, err),
      catch: (err: (e: unknown) => unknown) => rows().catch(err),
      orderBy: () => mk(),
      limit: async () => rows(),
      innerJoin: () => mk(),
      where: () => mk(),
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
              if (table === tasks) {
                h.taskReadCount += 1;
                if (h.taskReadThrowOn > 0 && h.taskReadCount === h.taskReadThrowOn)
                  throw new Error('task read exploded');
                const next = h.taskReads.length
                  ? h.taskReads.shift()!
                  : { status: h.taskStatus, updatedAt: h.taskUpdatedAt };
                return Promise.resolve([next]);
              }
              if (table === taskObligations) {
                if (keys.includes('employeeId')) {
                  h.holderConds.push(cond);
                  return Promise.resolve(h.holderRows);
                }
                if (keys.includes('id') && keys.includes('taskId')) {
                  h.answerConds.push(cond);
                  return Promise.resolve(h.answerObligationSelect);
                }
                if (keys.includes('taskId')) return Promise.resolve(h.answerLeftoverSelect);
                return Promise.resolve([]);
              }
              if (table === taskReviews) {
                if (keys.length === 1 && keys[0] === 'id') {
                  h.roundPendingConds.push(cond);
                  return Promise.resolve(h.roundPending);
                }
                if (keys.includes('round')) return Promise.resolve([{ round: h.round }]);
                if (keys.includes('resultBody')) return Promise.resolve([{ resultBody: 'submitted result' }]);
                if (keys.includes('id') && keys.includes('taskId')) return Promise.resolve(h.pendingSelect);
                if (keys.includes('taskId')) {
                  if (h.voidScanThrows) throw new Error('void scan exploded');
                  return Promise.resolve(h.leftoverSelect);
                }
                return Promise.resolve(h.reviewReads.shift() ?? []);
              }
              if (table === taskRuns) return Promise.resolve([]);
              return Promise.resolve([]);
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
              if (table === tasks) {
                h.seq.push('flip');
                return h.flipWins ? [{ id: 'task-1' }] : [];
              }
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
    cancelObligations: async (...args: unknown[]) => {
      h.seq.push('cancelAll');
      h.cancelled.push(String(args[0]));
    },
    cancelObligationById: async (id: string) => {
      h.seq.push('cancelById');
      h.cancelledById.push(id);
    },
    cancelOrphanAnswerObligations: async (...args: unknown[]) => {
      h.seq.push('cancelOrphan');
      h.orphanCalls.push([String(args[0]), args[1] as Date | undefined]);
      const real = mod as unknown as { cancelOrphanAnswerObligations: (...a: unknown[]) => Promise<void> };
      return real.cancelOrphanAnswerObligations(...args);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async (taskId: string) => {
    h.seq.push('dispatch');
    h.dispatched.push(taskId);
  },
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async (taskId: string) => {
    h.regated.push(taskId);
  },
}));

import {
  prepareReviewerRemoval,
  returnRemovedAnswerHolderTask,
  settleAllExtinguishedRounds,
  settleReviewerRemovalRounds,
  type ReviewerRemovalPlan,
} from '../../server/domains/tasks/review.service';

/** render a captured drizzle condition to SQL + params (DB-mock predicate law: pin
 * the predicate by RENDERING it, never by a presence check) */
function renderCond(cond: unknown, table: 'obligations' | 'tasks' | 'reviews' = 'obligations'): string {
  const tableDef = table === 'tasks' ? dbTasks : table === 'reviews' ? dbTaskReviews : dbTaskObligations;
  const q = mockDb()
    .select()
    .from(tableDef)
    .where(cond as never)
    .toSQL();
  return `${q.sql} ${JSON.stringify(q.params)}`;
}

function plan(over: Partial<ReviewerRemovalPlan> = {}): ReviewerRemovalPlan {
  return { taskIds: [], reviewRowIds: [], obligationIds: [], answerObligations: [], ...over };
}

beforeEach(() => {
  h.taskStatus = STATUS.waitingAnswer;
  h.taskUpdatedAt = new Date('2026-11-08T00:00:00Z');
  h.taskReads = [];
  h.taskReadThrowOn = 0;
  h.taskReadCount = 0;
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
  ];
  h.holderRows = [];
  h.holderConds = [];
  h.roundPendingConds = [];
  h.roundPending = [];
  h.orphanCalls = [];
  h.answerObligationSelect = [];
  h.answerLeftoverSelect = [];
  h.pendingSelect = [];
  h.leftoverSelect = [];
  h.voidScanThrows = false;
  h.seq = [];
  h.reviewReads = [];
  h.round = 0;
  h.aiEmployees = [];
  h.updates = [];
  h.deletes = [];
  h.cancelled = [];
  h.cancelledById = [];
  h.notes = [];
  h.regated = [];
  h.dispatched = [];
  h.published = 0;
  h.flipWins = true;
});

describe('ANSWER-ROLE REMOVAL prepare (#369)', () => {
  it('captures the departing holder’s PENDING ANSWER obligations (role/status/holder pinned)', async () => {
    h.answerObligationSelect = [{ id: 'ans-1', taskId: 'task-1' }];
    const res = await prepareReviewerRemoval('emp-1');
    expect(res.answerObligations).toEqual([{ id: 'ans-1', taskId: 'task-1' }]);
    expect(h.answerConds).toHaveLength(1);
    const sql = renderCond(h.answerConds[0]);
    expect(sql).toContain('"task_obligations"."role" =');
    expect(sql).toContain('"task_obligations"."status" =');
    expect(sql).toContain('"task_obligations"."employee_id" =');
    expect(sql).toContain('ANSWER');
    expect(sql).toContain('PENDING');
    expect(sql).toContain('emp-1');
  });

  it('captures answer obligations and review obligations without mixing roles', async () => {
    h.pendingSelect = [{ id: 'rev-1', taskId: 'task-2' }];
    h.answerObligationSelect = [{ id: 'ans-1', taskId: 'task-1' }];
    const res = await prepareReviewerRemoval('emp-1');
    expect(res.taskIds).toEqual(['task-2']);
    expect(res.reviewRowIds).toEqual(['rev-1']);
    expect(res.answerObligations).toEqual([{ id: 'ans-1', taskId: 'task-1' }]);
  });
});

describe('ANSWER-ROLE REMOVAL settle (#369)', () => {
  it('returns the waiting task to todo after a won flip and clears the orphan row', async () => {
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    const res = await settleReviewerRemovalRounds(
      plan({ answerObligations: [{ id: 'ans-1', taskId: 'task-1' }] }),
      'Departed Person',
    );
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.todo);
    expect(flip?.set.questionChain).toEqual([]);
    const flipSql = renderCond(flip?.cond, 'tasks');
    expect(flipSql).toContain('"status" =');
    expect(flipSql).toContain(STATUS.waitingAnswer);
    expect(flipSql).toContain('"updated_at" =');
    // the won flip's teardown clears the NULL-holder row (scoped — never a task-wide cancel)
    const orphan = h.updates.find((u) => u.table === 'taskObligations');
    const orphanSql = renderCond(orphan?.cond);
    expect(orphanSql).toContain('"employee_id" is null');
    expect(orphanSql).toContain('"role" =');
    expect(orphanSql).toContain('ANSWER');
    // the won flip already cleared it — the by-id fallback is not needed
    expect(h.cancelledById).toEqual([]);
    expect(h.notes.at(-1)?.body).toContain('answer holder removed');
    expect(h.notes.at(-1)?.body).toContain('Departed Person');
    expect(h.notes.at(-1)?.payload).toMatchObject({ answerHolderRemoved: true, returnedTo: STATUS.todo });
    expect(h.regated).toEqual(['task-1']);
    expect(res).toContain('task-1');
  });

  it('a BLOCKED task keeps its signature — the unblock may restore a waiting-answer status', async () => {
    h.taskStatus = STATUS.blocked;
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    // no write at all: the row is the signature its gating restore needs
    expect(h.updates).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.seq).toEqual([]);
  });

  it('a waiting task with ANOTHER live holder keeps waiting — only the orphan row is cleared', async () => {
    h.holderRows = [{ employeeId: 'someone-else' }];
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.updates.filter((u) => u.table === 'tasks')).toEqual([]);
    expect(h.cancelled).toEqual([]);
    expect(h.notes).toEqual([]);
    // the dead row must not keep masking the live holder in answerHolder()
    expect(h.updates.some((u) => u.table === 'taskObligations')).toBe(true);
    // the guard means 'ANY pending row names a live employee' — pin its predicate
    const guardSql = renderCond(h.holderConds[0]);
    expect(guardSql).toContain('"task_obligations"."employee_id" is not null');
    expect(guardSql).toContain('"task_obligations"."role" =');
    expect(guardSql).toContain('"task_obligations"."status" =');
    expect(guardSql).toContain('"task_obligations"."task_id" =');
    expect(guardSql).toContain('ANSWER');
    expect(guardSql).toContain('PENDING');
    expect(guardSql).toContain('task-1');
  });

  it('a live review round lands back IN-REVIEW and re-fires the AI reviewer', async () => {
    h.taskStatus = STATUS.waitingAnswer;
    h.round = 2;
    h.aiEmployees = [{ userId: 'rev-1' }];
    h.roundPending = [{ id: 'row-1' }];
    // dispatchAiReviewTurns' pending rows, then the settle's rows
    h.reviewReads = [
      [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1', createdAt: new Date() }],
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }],
    ];
    const healed = await returnRemovedAnswerHolderTask('task-1', 'Departed Person');
    expect(healed).toBe(true);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.inReview);
    expect(h.dispatched).toEqual(['task-1']);
    expect(h.regated).toEqual([]);
    expect(h.notes.some((n) => n.body.includes('review round resumes'))).toBe(true);
  });

  it('a round whose only reviewer was removed lands IN-REVIEW and settles by the matrix (all approved -> done)', async () => {
    h.taskStatus = STATUS.waitingAnswer;
    h.round = 2;
    h.aiEmployees = [];
    // the return arm reads waiting-answer, the settle then reads the flipped in-review row
    h.taskReads = [{ status: STATUS.waitingAnswer, updatedAt: h.taskUpdatedAt }];
    h.roundPending = [{ id: 'row-2' }]; // the void row keeps the round alive
    h.reviewReads = [
      [], // dispatchAiReviewTurns: no AI rows to mint
      [
        { status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null }, // deleted reviewer's void row
      ], // settle matrix read
    ];
    // after the return flip the task IS in-review for the settle's read
    h.taskReads.push({ status: STATUS.inReview, updatedAt: h.taskUpdatedAt });
    const healed = await returnRemovedAnswerHolderTask('task-1', 'Departed Person');
    expect(healed).toBe(true);
    const statuses = h.updates.filter((u) => u.table === 'tasks').map((u) => u.set.status);
    expect(statuses).toEqual([STATUS.inReview, STATUS.done]);
    // the round-pending discriminator pins round + status (never 'any row exists')
    const roundSql = renderCond(h.roundPendingConds[0], 'reviews');
    expect(roundSql).toContain('"round" =');
    expect(roundSql).toContain('"status" =');
    expect(roundSql).toContain('PENDING');
    expect(roundSql).toContain('task-1');
    expect(h.notes.some((n) => n.body.includes('review round resumes'))).toBe(true);
  });

  it('a LOST return flip keeps the machine signature — no by-id cancel while the task still waits on the orphan', async () => {
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    h.flipWins = false; // a concurrent write won the stamp
    const res = await settleReviewerRemovalRounds(
      plan({ answerObligations: [{ id: 'ans-1', taskId: 'task-1' }] }),
      'Ada',
    );
    // the flip is ATTEMPTED, and the NULL-holder row SURVIVES for the boot/next pass
    expect(h.seq).toEqual(['flip']);
    expect(h.cancelledById).toEqual([]);
    expect(res).toEqual([]);
    // a lost flip cancels nothing task-wide and leaves no note (the winner owns it)
    expect(h.cancelled).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('a lost flip on a task that moved on still cancels the departed row by id', async () => {
    h.flipWins = false;
    // return arm read: still waiting; the post-arm re-read: the task moved to todo
    h.taskReads = [
      { status: STATUS.waitingAnswer, updatedAt: h.taskUpdatedAt },
      { status: STATUS.todo, updatedAt: h.taskUpdatedAt },
    ];
    const res = await settleReviewerRemovalRounds(
      plan({ answerObligations: [{ id: 'ans-1', taskId: 'task-1' }] }),
      'Ada',
    );
    expect(h.seq).toEqual(['flip', 'cancelById']);
    expect(h.cancelledById).toEqual(['ans-1']);
    expect(res).toEqual([]);
  });

  it('never flips a task that is not in a waiting_answer status — it clears the NULL-holder orphan instead', async () => {
    h.taskStatus = STATUS.done;
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.updates.filter((u) => u.table === 'tasks')).toEqual([]);
    expect(h.notes).toEqual([]);
    // the stale row is cancelled, scoped to NULL holders (a concurrent ask/forward
    // spawn always names a holder and must never be touched)
    const orphan = h.updates.find((u) => u.table === 'taskObligations');
    expect(orphan?.set.status).toBe('CANCELLED');
    const sql = renderCond(orphan?.cond);
    expect(sql).toContain('"employee_id" is null');
    expect(sql).toContain('"role" =');
    expect(sql).toContain('ANSWER');
    // the age cut: only rows older than the task write the caller read are cleared
    expect(sql).toContain('"created_at" <');
    expect(h.orphanCalls.at(-1)?.[1]).toBe(h.taskUpdatedAt);
  });
});

describe('ANSWER-ROLE REMOVAL boot/removal sweep (#369)', () => {
  it('boot heal returns a waiting task whose ANSWER obligation lost its holder', async () => {
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    h.answerLeftoverSelect = [{ taskId: 'task-9' }];
    const healed = await settleAllExtinguishedRounds();
    expect(healed).toEqual(['task-9']);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.todo);
  });

  it('boot heal still runs the ANSWER scan when the void-review scan throws (fault isolation)', async () => {
    h.voidScanThrows = true;
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    h.answerLeftoverSelect = [{ taskId: 'task-9' }];
    const healed = await settleAllExtinguishedRounds();
    expect(healed).toEqual(['task-9']);
  });
});

describe('ANSWER-ROLE REMOVAL crash repairs (#369 r3)', () => {
  it('the removal sweep heals a leftover orphan ANSWER row from an earlier crash', async () => {
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    h.answerLeftoverSelect = [{ taskId: 'task-9' }];
    const healed = await settleReviewerRemovalRounds(plan());
    expect(healed).toContain('task-9');
    expect(h.updates.some((u) => u.table === 'tasks' && u.set.status === STATUS.todo)).toBe(true);
  });

  it('a FAILED post-arm re-read keeps the machine signature — no by-id cancel', async () => {
    // the return arm loses its flip, then the post-arm status read fails: the caller
    // must keep the departing row PENDING (a read error is never 'the task moved on')
    h.flipWins = false;
    h.taskReadThrowOn = 2; // 1 = the return arm's read, 2 = taskStillWaitsOnOrphan's
    const res = await settleReviewerRemovalRounds(
      plan({ answerObligations: [{ id: 'ans-1', taskId: 'task-1' }] }),
      'Ada',
    );
    expect(res).toEqual([]);
    expect(h.cancelledById).toEqual([]);
  });

  it('an IN-REVIEW crash repair also settles an extinguished round (matrix applies)', async () => {
    h.taskStatus = STATUS.inReview;
    h.round = 2;
    h.aiEmployees = [];
    h.reviewReads = [
      [], // dispatchAiReviewTurns: no AI rows to mint
      [
        { status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' },
        { status: REVIEW_STATUS.PENDING, reviewerId: null },
      ], // settle matrix: all approved -> done
    ];
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.updates.some((u) => u.table === 'tasks' && u.set.status === STATUS.done)).toBe(true);
  });

  it('an IN-REVIEW task that left waiting-answer re-fires its reviewer (crash repair)', async () => {
    h.taskStatus = STATUS.inReview;
    h.round = 2;
    h.aiEmployees = [{ userId: 'rev-1' }];
    h.reviewReads = [
      [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1', createdAt: new Date() }],
    ];
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.dispatched).toEqual(['task-1']);
    // the re-fire precedes the scoped cleanup (trigger-last)
    expect(h.seq).toEqual(['dispatch', 'cancelOrphan']);
  });
});
