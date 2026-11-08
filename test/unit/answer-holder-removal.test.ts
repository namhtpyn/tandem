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

import { mockDb, taskObligations as dbTaskObligations, tasks as dbTasks } from './helpers/mock-db';

const h = vi.hoisted(() => ({
  /** the task row the return arm reads */
  taskStatus: '' as string,
  taskUpdatedAt: new Date('2026-11-08T00:00:00Z'),
  statuses: [] as Array<{ id: string; category: string }>,
  /** rows for answerHolder(): [{ employeeId }] */
  holderRows: [] as Array<{ employeeId: string | null }>,
  /** the departing holder's PENDING ANSWER obligations: select({id, taskId}) */
  answerObligationSelect: [] as Array<{ id: string; taskId: string }>,
  /** conditions captured from the ANSWER capture read (predicate pin) */
  answerConds: [] as unknown[],
  /** orphan ANSWER obligations (NULL holder) seen by the sweeping scans */
  answerLeftoverSelect: [] as Array<{ taskId: string }>,
  /** pending review rows for prepareReviewerRemoval */
  pendingSelect: [] as Array<{ id: string; taskId: string }>,
  /** leftover void review rows */
  leftoverSelect: [] as Array<{ taskId: string }>,
  /** bare select().from(taskReviews) reads, in order */
  reviewReads: [] as Array<Array<Record<string, unknown>>>,
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
              if (table === tasks) return Promise.resolve([{ status: h.taskStatus, updatedAt: h.taskUpdatedAt }]);
              if (table === taskObligations) {
                if (keys.includes('employeeId')) return Promise.resolve(h.holderRows);
                if (keys.includes('id') && keys.includes('taskId')) {
                  h.answerConds.push(cond);
                  return Promise.resolve(h.answerObligationSelect);
                }
                if (keys.includes('taskId')) return Promise.resolve(h.answerLeftoverSelect);
                return Promise.resolve([]);
              }
              if (table === taskReviews) {
                if (keys.includes('round')) return Promise.resolve([{ round: h.round }]);
                if (keys.includes('resultBody')) return Promise.resolve([{ resultBody: 'submitted result' }]);
                if (keys.includes('id') && keys.includes('taskId')) return Promise.resolve(h.pendingSelect);
                if (keys.includes('taskId')) return Promise.resolve(h.leftoverSelect);
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
              if (table === tasks) return h.flipWins ? [{ id: 'task-1' }] : [];
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
      h.cancelled.push(String(args[0]));
    },
    cancelObligationById: async (id: string) => {
      h.cancelledById.push(id);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async (taskId: string) => {
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
function renderCond(cond: unknown, table: 'obligations' | 'tasks' = 'obligations'): string {
  const tableDef = table === 'tasks' ? dbTasks : dbTaskObligations;
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
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
  ];
  h.holderRows = [];
  h.answerObligationSelect = [];
  h.answerLeftoverSelect = [];
  h.pendingSelect = [];
  h.leftoverSelect = [];
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
  it('cancels the captured ANSWER obligation by id and returns the waiting task to todo', async () => {
    h.statuses = [
      { id: STATUS.todo, category: CATEGORY.READY },
      { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
    ];
    const res = await settleReviewerRemovalRounds(
      plan({ answerObligations: [{ id: 'ans-1', taskId: 'task-1' }] }),
      'Departed Person',
    );
    expect(h.cancelledById).toEqual(['ans-1']);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.todo);
    expect(flip?.set.questionChain).toEqual([]);
    const flipSql = renderCond(flip?.cond, 'tasks');
    expect(flipSql).toContain('"status" =');
    expect(flipSql).toContain('"updated_at" =');
    expect(h.cancelled).toContain('task-1');
    expect(h.notes.at(-1)?.body).toContain('answer holder removed');
    expect(h.notes.at(-1)?.body).toContain('Departed Person');
    expect(h.notes.at(-1)?.payload).toMatchObject({ answerHolderRemoved: true, returnedTo: STATUS.todo });
    expect(h.regated).toEqual(['task-1']);
    expect(res).toContain('task-1');
  });

  it('a waiting task with ANOTHER live holder is left untouched', async () => {
    h.holderRows = [{ employeeId: 'someone-else' }];
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.updates).toEqual([]);
    expect(h.cancelled).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('a live review round lands back IN-REVIEW and re-fires the AI reviewer', async () => {
    h.taskStatus = STATUS.waitingAnswer;
    h.round = 2;
    h.aiEmployees = [{ userId: 'rev-1' }];
    // openRoundLive read, then dispatchAiReviewTurns' pending-row read
    h.reviewReads = [
      [{ status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }],
      [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1', createdAt: new Date() }],
    ];
    const healed = await returnRemovedAnswerHolderTask('task-1', 'Departed Person');
    expect(healed).toBe(true);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.set.status).toBe(STATUS.inReview);
    expect(h.dispatched).toEqual(['task-1']);
    expect(h.regated).toEqual([]);
    expect(h.notes.some((n) => n.body.includes('review round resumes'))).toBe(true);
  });

  it('a LOST return flip touches nothing — the winning writer owns status and obligations', async () => {
    h.flipWins = false;
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.cancelled).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.regated).toEqual([]);
  });

  it('never flips a task that is not in a waiting_answer status', async () => {
    h.taskStatus = STATUS.done;
    const healed = await returnRemovedAnswerHolderTask('task-1');
    expect(healed).toBe(false);
    expect(h.updates).toEqual([]);
    expect(h.notes).toEqual([]);
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
});
