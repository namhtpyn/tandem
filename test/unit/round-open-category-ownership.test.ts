// CATEGORY-OWNERSHIP AT FLIP (#454 r2): the round-open transaction takes the STATUS
// MUTATION MUTEX as its FIRST statement and re-verifies the landing row's category
// under it. The verify-then-flip TOCTOU: the heal (and submit's caller-side gates) read the
// category OUTSIDE the transaction, and the flip's CAS pinned only the task row — an
// admin re-categorization landing between verify and flip let the flip win, minted live
// PENDING rows, and the mint gate (which reads the CURRENT category) dispatched nothing:
// a review flow owning a task its own category had just dissolved.
//
// r2 (blind-review r1, lens A — ACCEPTED P1): a row-level FOR KEY SHARE cannot do this
// job — a category re-key is a NON-KEY update (FOR NO KEY UPDATE), which does not
// conflict with FOR KEY SHARE — so the tx's FIRST statement now takes the STATUS
// MUTATION MUTEX (the same pg_advisory_xact_lock statuses.save/removal serialize on)
// and the category is re-verified under it: a re-categorization either commits before
// the read (the re-verify declines: nothing flipped, nothing minted, the caller routes
// the decline) or waits behind the transaction and lands AFTER it (the round then rides
// the manual-move-out semantics: the next in_review entry resumes, a settle tears down).
// Deadlock-free: the mutex precedes every row lock this tx takes, and save/removal
// take it before their own task-row writes.
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
  advisorySqls: [] as string[],
  advisoryTxIds: [] as number[],
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
            h.events.push('status-read');
            return {
              where: (cond: unknown) => {
                h.statusLockConds.push(cond);
                h.statusLockTxIds.push(txId);
                const params = dialect.sqlToQuery(cond as never).params as unknown[];
                const target = String(params[0]);
                h.statusLockIds.push(target);
                // predicate-faithful: only a status row that EXISTS answers
                return h.statusRowExists && target === h.statusRowId
                  ? { ...thenable(() => [{ category: h.statusCategory }]) }
                  : { ...thenable(() => []) };
              },
            };
          }
          if (table === user) {
            return {
              where: (cond: unknown) => ({
                for: async (strength: string) => {
                  h.events.push('user-lock');
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
    execute: function (this: { __tx?: number }, query: unknown) {
      const txId = this.__tx ?? 0;
      h.advisorySqls.push(dialect.sqlToQuery(query).sql);
      h.advisoryTxIds.push(txId);
      h.events.push('advisory');
      return Promise.resolve({ rows: [] });
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
  h.advisorySqls = [];
  h.advisoryTxIds = [];
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
  it('takes the STATUS MUTATION MUTEX as the tx FIRST statement, reads the landing row in the same tx', async () => {
    await openReviewRound(T, [A, B], 'the result', FLIP);
    // the mutex is the exact advisory lock statuses.save/removal serialize on
    expect(h.advisorySqls).toHaveLength(1);
    expect(h.advisorySqls[0]).toContain('pg_advisory_xact_lock');
    expect(h.advisorySqls[0]).toContain('tandem:task_statuses');
    // ordering pin: mutex FIRST, then the category read, then the reviewer
    // key-share, then the flip — no row lock is held while the mutex waits
    expect(h.events.slice(0, 3)).toEqual(['advisory', 'status-read', 'user-lock']);
    expect(h.events.indexOf('flip')).toBeGreaterThan(h.events.indexOf('user-lock'));
    // same tx for mutex, read, user lock, flip and minted rows
    expect(
      new Set([...h.advisoryTxIds, ...h.statusLockTxIds, ...h.lockTxIds, ...h.flipTxIds, ...h.insertTxIds]).size,
    ).toBe(1);
    const readSql = new PgDialect().sqlToQuery(h.statusLockConds[0] as never);
    expect(readSql.sql).toContain('"task_statuses"."id" =');
    expect(h.statusLockIds).toEqual([STATUS.inReview]);
  });

  it('a re-categorization the re-verify read sees (committed before it, serialized by the mutex) declines the mint', async () => {
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
