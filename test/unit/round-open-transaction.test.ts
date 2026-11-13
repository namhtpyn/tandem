// ROUND OPEN IS ONE TRANSACTION WITH THE IN-REVIEW FLIP (#394).
//
// The round number is allocated as max(round)+1, so two concurrent submits used to mint
// rows under the same number (or the later one a HIGHER number) and the submit that lost
// the flip had to tear its rows back down. Every teardown shape leaked: a round-scoped
// supersede killed the winner's rows and obligations; an id-scoped one left the round
// NUMBER behind (currentRound then addressed a round that never opened — human verdicts
// refused and the sequential dispatch minted nothing for the live round); deleting the
// rows detached a review turn that had already been dispatched for them.
//
// The flip is the transaction's FIRST write, so a submit that loses the arbitration
// writes NOTHING — no rows, no obligations, no round number, no reviewer turn. Only a
// won flip allocates a round. This file pins that contract plus the #364 reviewer-
// existence lock that rides the same transaction.
//
// The mock is transaction-IDENTITY aware (#364 TX-IDENTITY PIN LAW): the flip, every
// row insert and every obligation spawn must carry the same non-zero transaction id.
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_STATUS } from '#shared/enums';
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
  // #454 r2: the landing status row's category — the round-open tx re-verifies it
  // in_review under the status-mutation mutex (hoisted literal: vi.hoisted precedes imports)
  statusCategory: 'in_review' as string,
  advisorySqls: [] as string[],
  lockTxIds: [] as number[],
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
              // #454 r2: a PLAIN read (the mutex, not a row lock, serializes it) —
              // predicate-faithful enough for this file: the landing status row exists
              // and carries h.statusCategory
              where: async () => [{ category: h.statusCategory }],
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
              // (taskId, round, status) — the dispatch scan; a 1-param where is the
              // currentRound read (`limit(1)`), answered by the chain below
              if (params.length === 3) {
                const [taskId, round, status] = params;
                return chain(() =>
                  h.rows.filter(
                    (r) => r.taskId === String(taskId) && r.round === Number(round) && r.status === String(status),
                  ),
                );
              }
              // faithful to state: after a won open the max round is the minted one
              // only a taskReviews read is the currentRound query; every other table
              // (the dispatch in-flight probe) answers empty
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
    execute: function (this: { __tx?: number }, query: unknown) {
      const txId = this.__tx ?? 0;
      // #454 r2: the round-open tx's first statement — the status-mutation mutex
      h.advisorySqls.push(dialect.sqlToQuery(query).sql);
      void txId;
      return Promise.resolve({ rows: [] });
    },
    insert: function (this: { __tx?: number }, table: unknown) {
      const txId = this.__tx ?? 0;
      return {
        values: async (vals: Record<string, unknown>) => {
          h.insertTxIds.push(txId);
          if (table === taskReviews) {
            h.events.push('review-row');
            h.rows.push({
              id: String(vals.id),
              taskId: String(vals.taskId),
              reviewerId: vals.reviewerId == null ? null : String(vals.reviewerId),
              round: Number(vals.round),
              status: String(vals.status),
              resultBody: String(vals.resultBody ?? ''),
              createdAt: (vals.createdAt as Date) ?? new Date(),
            });
            h.seq += 1;
          }
          if (table === taskObligations) {
            h.events.push('obligation');
            h.obligations.push(
              vals as unknown as { id: string; taskId: string; employeeId: string; role: string; status: string },
            );
          }
          return { returning: async () => [{ id: `row-${h.seq}` }] };
        },
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...mockDb, __tx: ++h.txSeq }),
  };
  return { asDb: (x: unknown) => x, db: mockDb };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string }) => {
      h.events.push('note');
      h.notes.push(args);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts: { reviewBy: string; resultBody: string }) => {
      h.events.push('dispatch');
      h.dispatched.push({ reviewerId: opts.reviewBy, body: opts.resultBody });
      return { runId: 'run-1' };
    },
  };
});

import { canonicalStoredUuid, openReviewRound } from '../../server/domains/tasks/review.service';

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
  h.statusCategory = 'in_review';
  h.advisorySqls = [];
  h.lockTxIds = [];
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

describe('canonicalStoredUuid (#361)', () => {
  it('canonicalizes braced, hyphenless, uppercase and padded stored spellings', () => {
    expect(canonicalStoredUuid(`{${A}}`)).toBe(A);
    expect(canonicalStoredUuid(A.replaceAll('-', ''))).toBe(A);
    expect(canonicalStoredUuid(A.toUpperCase())).toBe(A);
    expect(canonicalStoredUuid(`  ${A}  `)).toBe(A);
  });

  it('answers null for values that cannot name a uuid', () => {
    expect(canonicalStoredUuid('alice')).toBeNull();
    expect(canonicalStoredUuid('')).toBeNull();
    expect(canonicalStoredUuid(`${A}-extra`)).toBeNull();
  });
});

describe('round open + in-review flip are one transaction (#394)', () => {
  it('commits the flip, the round rows and their obligations with ONE transaction id', async () => {
    const opened = await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(opened).toEqual({ flipped: true, round: 2, opened: 2, dropped: [] });
    // the flip arbitrates on the status AND the updatedAt stamp this submit read
    const flipSql = new PgDialect().sqlToQuery(h.flipConds[0] as never);
    expect(flipSql.sql).toContain('"tasks"."status" =');
    expect(flipSql.sql).toContain('"tasks"."updated_at" =');
    expect(flipSql.params.slice(0, 2)).toEqual([T, FLIP.status]);
    expect(new Date(flipSql.params[2] as string).getTime()).toBe(FLIP.updatedAt.getTime());
    // the flip LANDS the task in-review (a wrong target status would strand the round:
    // the verdicts gate on the in-review category and no teardown closes a working move)
    expect(h.flipSets[0]).toMatchObject({ status: STATUS.inReview });
    // TX-IDENTITY: the flip AND every row insert ride the SAME non-zero transaction
    const txIds = [...h.flipTxIds, ...h.insertTxIds];
    expect(h.rows).toHaveLength(2);
    expect(h.obligations).toHaveLength(2);
    expect(new Set(txIds).size).toBe(1);
    expect(txIds[0]).toBeGreaterThan(0);
  });

  it('a LOST flip mints NOTHING — no rows, no obligations, no note, no reviewer turn', async () => {
    h.flipWins = false;
    const opened = await openReviewRound(T, [A, B], 'the result', FLIP);
    expect(opened).toEqual({ flipped: false, round: 2, opened: 2, dropped: [] });
    expect(h.rows).toEqual([]);
    expect(h.obligations).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it('a WON flip notes the round after the commit and leaves the reviewer turn to the caller', async () => {
    h.aiIds = [A];
    const opened = await openReviewRound(T, [A], 'the result', FLIP);
    expect(opened.flipped).toBe(true);
    // the turn is the caller's post-flip step: the submit still has to re-gate parents,
    // and a park raised here would be undone by that gating restore (#394 r4)
    expect(h.dispatched).toEqual([]);
    expect(h.notes.some((n) => n.body.includes('review round 2 opened'))).toBe(true);
    // ordering: the flip precedes its rows, and the note lands after the commit
    expect(h.events.slice(0, 3)).toEqual(['flip', 'review-row', 'obligation']);
    expect(h.events.indexOf('note')).toBeGreaterThan(h.events.indexOf('obligation'));
  });
});

describe('openReviewRound reviewer-existence transaction (#364)', () => {
  it('locks the reviewer rows FOR KEY SHARE inside the same transaction as the flip', async () => {
    await openReviewRound(T, [A, B], 'result', FLIP);
    expect(h.lockStrengths).toEqual(['key share']);
    const lockSql = new PgDialect().sqlToQuery(h.lockConds[0] as never);
    expect(lockSql.sql).toContain('"user"."id" in (');
    // `in` alone is satisfied by `not in` — pin the operator, not the substring
    expect(lockSql.sql).not.toMatch(/\bnot in\b/);
    expect(lockSql.params).toEqual([A, B]);
    expect(new Set([...h.lockTxIds, ...h.flipTxIds, ...h.insertTxIds]).size).toBe(1);
    expect(h.lockTxIds[0]).toBeGreaterThan(0);
  });

  it('a reviewer deleted inside the pre-check→lock window drops out — the survivors still open the round', async () => {
    h.deletedUsers = [B];
    const opened = await openReviewRound(T, [A, B], 'result', FLIP);
    expect(opened).toMatchObject({ flipped: true, opened: 1, dropped: [B] });
    expect(h.rows.map((r) => r.reviewerId)).toEqual([A]);
    // a drop is not a failure: the survivors' rows and obligations are normal
    expect(h.obligations).toHaveLength(1);
    expect(h.notes[0]?.body).toContain('waiting on 1 reviewer(s)');
  });

  it('every reviewer gone inside the window mints nothing, flips nothing, and reports opened: 0', async () => {
    h.deletedUsers = [A, B];
    const opened = await openReviewRound(T, [A, B], 'result', FLIP);
    expect(opened).toEqual({ flipped: false, round: 0, opened: 0, dropped: [A, B] });
    expect(h.rows).toEqual([]);
    expect(h.obligations).toEqual([]);
    // nothing opened: no note may claim a round is waiting on reviewers, and no flip ran
    expect(h.notes).toEqual([]);
    expect(h.flipTxIds).toEqual([]);
  });
});
