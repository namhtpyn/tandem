// REVIEW-TURN MINT GATE + OFF-REVIEW SETTLE REFUSAL (#401): a review turn can be
// minted for a task a manual move took out of review, and the end-of-round flip used
// to refuse only done/cancelled-category statuses — an all-approved settle therefore
// flipped a manually re-queued todo task to done, overriding the owner's move.
//
// The flip's mock ENFORCES the predicate it renders (a mock that returns rows
// regardless would pass every ordering): the flip lands only when the rendered SQL's
// status list contains the row's CURRENT status, so removing the in-review gate turns
// the refusal cases green-but-wrong and fails them here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  task: { id: 'task-1', status: '' },
  statuses: [] as Array<{ id: string; category: string }>,
  roundRows: [] as Array<Record<string, unknown>>,
  matrixRows: [] as Array<Record<string, unknown>>,
  pendingRows: [] as Array<Record<string, unknown>>,
  aiEmployees: [] as Array<{ userId: string }>,
  /** rendered predicates of every tasks UPDATE, in order */
  flips: [] as Array<{ sql: string; params: unknown[]; set: Record<string, unknown> }>,
  dispatched: [] as Array<Record<string, unknown>>,
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  cancelledAll: [] as string[],
  published: 0,
  casMiss: false,
  /** taskReviews read counter: [1] the verdict's own row, [2] the settle matrix, [3+] mint rows */
  reviewRead: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskRuns } = await import('../../server/db/schema');
  const rowsThenable = (resolve: () => Array<Record<string, unknown>>) => {
    const p = () => Promise.resolve(resolve());
    return {
      then: (onF?: (v: Array<Record<string, unknown>>) => unknown, onR?: (e: unknown) => unknown) => p().then(onF, onR),
      catch: (onR: (e: unknown) => unknown) => p().catch(onR),
    };
  };
  const reviewRows = () => {
    h.reviewRead += 1;
    return h.reviewRead === 1 ? h.roundRows : h.reviewRead === 2 ? h.matrixRows : h.pendingRows;
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const resolve = (): Array<Record<string, unknown>> => {
            if (table === tasks && cols && 'status' in cols) return [{ status: h.task.status }];
            if (table === taskRuns) return []; // no live run on the task
            if (table === taskReviews) {
              if (cols && 'round' in cols) return [{ round: 1 }];
              if (cols && 'resultBody' in cols) return [{ resultBody: 'submitted work' }];
              return reviewRows();
            }
            return [];
          };
          const chain: Record<string, unknown> = {
            where: () => chain,
            innerJoin: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            ...rowsThenable(resolve),
          };
          return chain;
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: { toQuery?: (cfg: unknown) => { sql: string; params: unknown[] } }) => {
            const applied = () => {
              if (table !== tasks) return [{ id: 'row-1' }]; // the verdict CAS
              // drizzle's SQL renders through toQuery (no toSQL in this version)
              const rendered = cond?.toQuery?.({
                escapeName: (n: string) => `"${n}"`,
                escapeParam: (i: number) => `$${i + 1}`,
              }) ?? { sql: '', params: [] };
              h.flips.push({ ...rendered, set });
              // ENFORCE the rendered predicate: an `in (...)` status list must contain
              // the row's current status; a `not in (...)` list must exclude it.
              const inList = /"tasks"\."status" in \(/.test(rendered.sql);
              const notInList = /"tasks"\."status" not in \(/.test(rendered.sql);
              const allowed = inList
                ? rendered.params.includes(h.task.status)
                : notInList
                  ? !rendered.params.includes(h.task.status)
                  : true;
              if (!allowed) return [];
              if (typeof set.status === 'string') h.task.status = set.status;
              return [{ id: h.task.id }];
            };
            return {
              ...rowsThenable(applied),
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
  return { ...mod, publishChange: async () => void (h.published += 1) };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    resolveObligation: async () => {},
    cancelObligations: async () => {},
    cancelAllObligations: async (_t: unknown, role: unknown) => void h.cancelledAll.push(String(role)),
    spawnObligation: async () => {},
    spawnObligationTracked: async () => ({ created: true }),
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts?: Record<string, unknown>) => {
      h.dispatched.push(opts ?? {});
      return { runId: 'run-1' };
    },
  };
});

import { dispatchAiReviewTurns, recordVerdict } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.task = { id: 'task-1', status: STATUS.inReview };
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: 'st-review-custom', category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
    { id: STATUS.cancelled, category: CATEGORY.CANCELLED },
  ];
  h.roundRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
  h.matrixRows = [{ round: 1, status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' }];
  h.pendingRows = [];
  h.aiEmployees = [{ userId: 'rev-1' }];
  h.flips = [];
  h.dispatched = [];
  h.notes = [];
  h.cancelledAll = [];
  h.published = 0;
  h.casMiss = false;
  h.reviewRead = 0;
});

describe('off-review settle refusal (#401)', () => {
  it('an all-approved settle never flips a task the owner moved out of review', async () => {
    h.task.status = STATUS.todo;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.todo); // the owner's move stands
    expect(h.notes).toHaveLength(0); // no settle-arm note
    expect(h.published).toBe(0);
    // the flip was ATTEMPTED with the in-review allow-list — the refusal is the write's
    expect(h.flips).toHaveLength(1);
  });

  it('an all-rejected settle never cancels a task the owner moved out of review', async () => {
    h.task.status = STATUS.todo;
    h.matrixRows = [{ round: 1, status: REVIEW_STATUS.REJECTED, reviewerId: 'rev-1' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.REJECTED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.todo);
    expect(h.cancelledAll).toHaveLength(0);
  });

  it('the same settle still completes a task that is in review', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
    expect(h.published).toBeGreaterThan(0);
  });

  it('a CUSTOM in-review-category status accepts the flip (category, never the seeded id)', async () => {
    h.task.status = 'st-review-custom';
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
  });

  it('the flip predicate is an in-review ALLOW-list: both in-review statuses, no other status, no deny-list', async () => {
    await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    const flip = h.flips[0];
    expect(flip?.sql).toContain('"tasks"."status" in (');
    expect(flip?.sql).not.toMatch(/\bnot in\b/);
    expect(flip?.params).toEqual(['task-1', STATUS.inReview, 'st-review-custom']);
  });
});

describe('review-turn mint gate (#401)', () => {
  it('mints nothing for a task that left review', async () => {
    h.task.status = STATUS.todo;
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('mints the next turn while the task is in review', async () => {
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.reviewBy).toBe('rev-1');
  });

  it('a CUSTOM in-review-category status mints (category, never the seeded id)', async () => {
    h.task.status = 'st-review-custom';
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
  });
});
