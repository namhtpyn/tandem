// CATEGORY-OWNERSHIP AT FLIP (#454): the round-open transaction takes FOR KEY SHARE on
// the LANDING status row as the tx's FIRST lock and re-verifies its category before the
// flip. The verify-then-flip TOCTOU: the heal (and submit's caller-side gates) read the
// category OUTSIDE the transaction, and the flip's CAS pinned only the task row — an
// admin re-categorization landing between verify and flip let the flip win, minted live
// PENDING rows, and the mint gate (which reads the CURRENT category) dispatched nothing:
// a review flow owning a task its own category had just dissolved.
//
// The tx now key-shares the status row first — the re-categorization either commits
// before the read (the re-verify declines: nothing flipped, nothing minted, the caller
// routes the decline) or serializes AFTER the round commits (the round then rides the
// manual-move-out semantics: the next in_review entry resumes, a settle tears down).
// Taking the share FIRST makes the ordering deadlock-free: statuses.save's advisory
// mutex touches no task row before its status write, and the removal's re-home cannot
// start while this tx holds the share.
//
// The mock is transaction-IDENTITY aware (#364 TX-IDENTITY PIN LAW).
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

type ReviewRow = {
  id: string;
  taskId: string;
  reviewerId: string | null;
  round: number;
  status: string;
  resultBody: string;
  createdAt: Date;
};

const h = vi.hoisted(() => ({
  rows: [] as ReviewRow[],
  obligations: [] as Array<{ id: string; taskId: string; employeeId: string; role: string; status: string }>,
  flipWins: true,
  currentRound: 1,
  deletedUsers: [] as string[],
  lockStrengths: [] as string[],
  lockConds: [] as unknown[],
  lockTxIds: [] as number[],
  statusLockStrengths: [] as string[],
  statusLockConds: [] as unknown[],
  statusLockTxIds: [] as number[],
  // hoisted literals: vi.hoisted runs before imports resolve (#hoisted-isolation)
  statusCategory: 'in_review' as string,
  statusRowExists: true,
  statusRowId: '01a14743-43f5-759d-a00e-a90831248ea5',
  statusLockIds: [] as string[],
  obligationConds: [] as unknown[],
  insertTxIds: [] as number[],
  flipTxIds: [] as number[],
  flipConds: [] as unknown[],
  flipSets: [] as Array<Record<string, unknown>>,
  events: [] as string[],
  notes: [] as Array<{ body: string }>,
  dispatched: [] as Array<{ reviewerId: string; body: string }>,
  aiIds: [] as string[],
  txSeq: 0,
  seq: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { taskObligations, taskReviews, taskRuns, taskStatuses, user } = await import('../../server/db/schema');
  const dialect = new PgDialect();
  const thenable = (rows: () => unknown[]) => ({
    then: (onF?: (v: unknown) => unknown) => Promise.resolve(rows()).then(onF),
    catch: (onR?: (e: unknown) => unknown) => Promise.resolve(rows()).catch(onR),
  });
  const mockDb = {
    query: new Proxy({} as Record<string, { findMany: () => Promise<unknown[]> }>, {
      get: (_t, prop) => ({
        findMany: async () => (prop === 'aiEmployees' ? h.aiIds.map((userId) => ({ userId })) : []),
      }),
    }),
    select: function (this: { __tx?: number }) {
      const txId = this.__tx ?? 0;
      return {
        from: (table: unknown) => {
          if (table === taskStatuses) {
            return {
              where: (cond: unknown) => ({
                for: async (strength: string) => {
                  h.statusLockStrengths.push(strength);
                  h.statusLockConds.push(cond);
                  h.statusLockTxIds.push(txId);
                  const params = dialect.sqlToQuery(cond as never).params as unknown[];
                  const target = String(params[0]);
                  h.statusLockIds.push(target);
                  // predicate-faithful: only a status row that EXISTS answers
                  return h.statusRowExists && target === h.statusRowId ? [{ category: h.statusCategory }] : [];
                },
              }),
            };
          }
          if (table === user) {
            return {
              where: (cond: unknown) => ({
                for: async (strength: string) => {
                  h.lockStrengths.push(strength);
                  h.lockConds.push(cond);
                  h.lockTxIds.push(txId);
                  const ids = (dialect.sqlToQuery(cond as never).params as string[]).map(String);
                  return ids.filter((id) => !h.deletedUsers.includes(id)).map((id) => ({ id }));
                },
              }),
            };
          }
          if (table === taskObligations) {
            return {
              where: (cond: unknown) => {
                h.obligationConds.push(cond);
                return thenable(() => []);
              },
            };
          }
          const chain = (rows: () => unknown[]) => {
            const w: Record<string, unknown> = {
              orderBy: () => w,
              innerJoin: () => w,
              limit: () => thenable(rows),
              ...thenable(rows),
            };
            w.where = () => w;
            return w;
          };
          const b: Record<string, unknown> = {
            innerJoin: () => b,
            orderBy: () => b,
            where: (cond: unknown) => {
              const params = dialect.sqlToQuery(cond as never).params as unknown[];
              if (params.length === 3) {
                const [taskId, round, status] = params;
                return chain(() =>
                  h.rows.filter(
                    (r) => r.taskId === String(taskId) && r.round === Number(round) && r.status === String(status),
                  ),
                );
              }
              if (table !== taskReviews) return chain(() => []);
              return chain(() => [{ round: h.rows.length ? Math.max(...h.rows.map((r) => r.round)) : h.currentRound }]);
            },
            limit: () => thenable(() => []),
            ...thenable(() => []),
          };
          return b;
        },
      };
    },
    insert: function (this: { __tx?: number }, table: unknown) {
      const txId = this.__tx ?? 0;
      return {
        values: async (vals: Record<string, unknown>) => {
          h.insertTxIds.push(txId);
          if (table === taskReviews) {
            h.rows.push(vals as unknown as ReviewRow);
            h.events.push('review-row');
          }
          if (table === taskObligations) {
            h.obligations.push(vals as unknown as (typeof h.obligations)[number]);
            h.events.push('obligation');
          }
          return { returning: async () => [{ id: `row-${(h.seq += 1)}` }] };
        },
      };
    },
    update: function (this: { __tx?: number }, table: unknown) {
      const txId = this.__tx ?? 0;
      if (table !== (taskReviews as unknown) && table !== (taskObligations as unknown)) {
        // the tasks flip — the transaction's first write
        h.flipTxIds.push(txId);
        return {
          set: (payload: Record<string, unknown>) => ({
            where: (cond: unknown) => {
              h.flipConds.push(cond);
              h.flipSets.push(payload);
              h.events.push('flip');
              return { returning: async () => (h.flipWins ? [{ id: 'task-1' }] : []) };
            },
          }),
        };
      }
      return {
        set: () => ({
          where: async () => {},
        }),
      };
    },
    transaction: async (fn: (tx: { __tx: number } & typeof mockDb) => Promise<unknown>) =>
      await fn({ ...mockDb, __tx: ++h.txSeq }),
  };
  return { asDb: (x: unknown) => x, db: mockDb };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    spawnObligation: async (_taskId: string, _reviewerId: string, _role: string) => {
      h.obligations.push({
        id: `obl-${h.seq++}`,
        taskId: 'task-1',
        employeeId: 'rev',
        role: 'reviewer',
        status: 'pending',
      });
      return 'obl-1';
    },
    resolveObligation: async () => {},
    cancelObligations: async () => {},
    cancelAllObligations: async () => {},
    answerHolder: async () => null,
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    addThreadMessage: async (_taskId: string, _authorId: string | null, body: string, _opts?: unknown) => {
      h.notes.push({ body });
      h.events.push('note');
      return { id: 'msg-1' };
    },
    insertActivityMessage: async () => ({ id: 'msg-1' }),
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async (_taskId: string, opts: { reviewBy?: string; resultBody?: string }) => {
    h.events.push('dispatch');
    h.dispatched.push({ reviewerId: opts.reviewBy ?? '', body: opts.resultBody ?? '' });
    return { runId: 'run-1' };
  },
}));

import { openReviewRound } from '../../server/domains/tasks/review.service';

const T = 'task-1';
const A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const FLIP = { status: 'st-doing', updatedAt: new Date('2026-01-01T00:00:00Z') };

beforeEach(() => {
  h.rows = [];
  h.obligations = [];
  h.flipWins = true;
  h.currentRound = 1;
  h.deletedUsers = [];
  h.lockStrengths = [];
  h.lockConds = [];
  h.lockTxIds = [];
  h.statusLockStrengths = [];
  h.statusLockConds = [];
  h.statusLockTxIds = [];
  h.statusLockIds = [];
  h.statusCategory = CATEGORY.IN_REVIEW;
  h.statusRowExists = true;
  h.statusRowId = STATUS.inReview;
  h.obligationConds = [];
  h.insertTxIds = [];
  h.flipTxIds = [];
  h.flipConds = [];
  h.flipSets = [];
  h.events = [];
  h.notes = [];
  h.dispatched = [];
  h.aiIds = [];
  h.txSeq = 0;
  h.seq = 0;
});

describe('openReviewRound category-ownership lock (#454)', () => {
  it('key-shares the landing status row FOR KEY SHARE as the tx FIRST lock, same tx as the flip', async () => {
    await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(h.statusLockStrengths).toEqual(['key share']);
    const lockSql = new PgDialect().sqlToQuery(h.statusLockConds[0] as never);
    expect(lockSql.sql).toContain('"task_statuses"."id" =');
    expect(h.statusLockIds).toEqual([STATUS.inReview]);
    // FIRST lock: the status share precedes the reviewer key-share and the flip
    expect(h.statusLockTxIds[0]).toBeGreaterThan(0);
    expect(new Set([...h.statusLockTxIds, ...h.lockTxIds, ...h.flipTxIds, ...h.insertTxIds]).size).toBe(1);
    expect(h.events.indexOf('flip')).toBeGreaterThan(-1);
  });

  it('a status row re-categorized OUT of in_review inside the verify→flip window declines the mint', async () => {
    h.statusCategory = 'working';
    const opened = await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(opened).toEqual({ flipped: false, round: 0, opened: 0, dropped: [], declined: 'category' });
    // nothing written: no flip, no round rows, no obligations, no note, no reviewer turn
    expect(h.flipTxIds).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(h.obligations).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it('a dangling landing status (no row) declines the mint the same way', async () => {
    h.statusRowExists = false;
    const opened = await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(opened).toEqual({ flipped: false, round: 0, opened: 0, dropped: [], declined: 'category' });
    expect(h.statusLockIds).toEqual([STATUS.inReview]);
    expect(h.flipTxIds).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(h.obligations).toEqual([]);
  });

  it('an in_review landing still opens the round (the guard does not over-decline)', async () => {
    const opened = await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(opened).toEqual({ flipped: true, round: 2, opened: 2, dropped: [] });
    expect(h.rows).toHaveLength(2);
    expect(h.obligations).toHaveLength(2);
  });
});
