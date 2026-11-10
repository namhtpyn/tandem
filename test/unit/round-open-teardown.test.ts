import { PgDialect } from 'drizzle-orm/pg-core';
// ROUND-OPEN ROLLBACK (#361 r3/r4/r5): a reviewer insert that fails mid-loop (FK miss
// on a ghost that raced the existence read, or a unique-index hit from a duplicate
// submit) must not leave a half-minted round — and the rollback must touch ONLY what
// this call created: supersede its own row ids, cancel its own obligation ids. Neither
// the task's MAX round nor an older live round's obligation may be collateral.
// The obligations service is NOT mocked here: the rollback runs through the real
// spawnObligationTracked / cancelObligationById and their SQL is asserted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  rowInserts: [] as string[],
  obligationConds: [] as unknown[],
  supersedeConds: [] as unknown[],
  supersedeSets: [] as Array<Record<string, unknown>>,
  insertedObligations: [] as string[],
  failOnInsert: 0,
  failOnObligation: 0,
  obligationSpawns: 0,
  existingObligationId: null as string | null,
  // #364: the reviewer-existence transaction — which ids the FOR KEY SHARE lock still
  // sees, the lock strength it was asked for, and whether each insert ran inside the tx
  deletedUsers: [] as string[],
  lockStrengths: [] as string[],
  inTx: false,
  insertInTx: [] as boolean[],
  notes: [] as Array<{ body: string }>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskReviews, taskObligations, user } = await import('../../server/db/schema');
  const thenable = (rows: () => unknown[]) => ({
    then: (onF?: (v: unknown) => unknown) => Promise.resolve(rows()).then(onF),
    catch: (onR?: (e: unknown) => unknown) => Promise.resolve(rows()).catch(onR),
  });
  // self-chaining builder: spawnObligation awaits …where(); currentRound …orderBy().limit(1);
  // the dispatch live-run read …innerJoin().where().limit(1). Rows are table-shaped so a
  // stray arm can never be mistaken for a live run.
  const builderFor = (table: unknown): Record<string, unknown> => {
    const rows = () => {
      if (table === taskObligations) return h.existingObligationId ? [{ id: h.existingObligationId }] : [];
      if (table === taskReviews) return [{ round: 1 }];
      return [];
    };
    const b: Record<string, unknown> = {
      innerJoin: () => b,
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      ...thenable(rows),
    };
    return b;
  };
  const mockDb = {
    // every relational read answers empty: this file pins the round-open write path,
    // and an empty roster/live-run read is the "nothing in flight" shape
    query: new Proxy({} as Record<string, { findMany: () => Promise<unknown[]> }>, {
      get: () => ({ findMany: async () => [] }),
    }),
    select: () => ({
      from: (table: unknown) => {
        if (table === user) {
          // the round-open reviewer lock (#364): honor the caller's id predicate
          // (DB-mock predicate law) and answer only the rows a delete has not taken
          return {
            where: (cond: unknown) => ({
              for: async (strength: string) => {
                h.lockStrengths.push(strength);
                const ids = (new PgDialect().sqlToQuery(cond as never).params as string[]).map(String);
                return ids.filter((id) => !h.deletedUsers.includes(id)).map((id) => ({ id }));
              },
            }),
          };
        }
        return builderFor(table);
      },
    }),
    insert: (table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        h.insertInTx.push(h.inTx);
        if (table === taskReviews) {
          if (h.failOnInsert > 0 && h.rowInserts.length + 1 === h.failOnInsert) throw new Error('insert_fk_miss');
          h.rowInserts.push(String(vals.reviewerId));
        }
        if (table === taskObligations) {
          h.obligationSpawns += 1;
          if (h.failOnObligation > 0 && h.obligationSpawns === h.failOnObligation)
            throw new Error('obligation_insert_failed');
          h.insertedObligations.push(String(vals.id));
        }
        return { returning: async () => [{ id: `msg-${h.rowInserts.length}` }] };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          if (table === taskReviews) {
            h.supersedeSets.push(vals);
            h.supersedeConds.push(cond);
          }
          if (table === taskObligations) h.obligationConds.push(cond);
        },
      }),
    }),
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      ...mockDb,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        h.inTx = true;
        try {
          return await fn(mockDb);
        } finally {
          h.inTx = false;
        }
      },
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async (args: { body: string }) => void h.notes.push(args) };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { canonicalStoredUuid, openReviewRound } from '../../server/domains/tasks/review.service';

const A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  h.rowInserts = [];
  h.obligationConds = [];
  h.supersedeConds = [];
  h.supersedeSets = [];
  h.insertedObligations = [];
  h.failOnInsert = 0;
  h.failOnObligation = 0;
  h.obligationSpawns = 0;
  h.existingObligationId = null;
  h.deletedUsers = [];
  h.lockStrengths = [];
  h.inTx = false;
  h.insertInTx = [];
  h.notes = [];
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

describe('openReviewRound rollback scope (#361 r3/r4/r5)', () => {
  it('a mid-loop failure supersedes only its own row ids and cancels only its own obligation id', async () => {
    h.failOnInsert = 2;
    await expect(openReviewRound('task-1', [A, B], 'result')).rejects.toThrow('insert_fk_miss');
    expect(h.rowInserts).toEqual([A]);
    expect(h.supersedeSets).toHaveLength(1);
    expect(h.supersedeSets[0]).toMatchObject({ status: REVIEW_STATUS.SUPERSEDED });
    const supersedeSql = new PgDialect().sqlToQuery(h.supersedeConds[0] as never).sql;
    expect(supersedeSql).toContain('"task_reviews"."id" in');
    expect(supersedeSql).not.toContain('"round"');
    // the cancelled obligation is exactly the row THIS call created (same id)
    expect(h.insertedObligations).toHaveLength(1);
    expect(h.obligationConds).toHaveLength(1);
    const cancelSql = new PgDialect().sqlToQuery(h.obligationConds[0] as never);
    expect(cancelSql.sql).toContain('"task_obligations"."id" =');
    expect(cancelSql.sql).toContain('"status" =');
    expect(cancelSql.params).toContain(h.insertedObligations[0]);
  });

  it('supersedes EVERY row this call minted before the failure — by id, in one list', async () => {
    const C = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
    h.failOnInsert = 3;
    await expect(openReviewRound('task-1', [A, B, C], 'result')).rejects.toThrow('insert_fk_miss');
    expect(h.rowInserts).toEqual([A, B]);
    const sql = new PgDialect().sqlToQuery(h.supersedeConds[0] as never);
    expect(sql.params).toHaveLength(2);
  });

  it('an OBLIGATION-insert failure after the row insert still rolls that row back', async () => {
    h.failOnObligation = 2;
    await expect(openReviewRound('task-1', [A, B], 'result')).rejects.toThrow('obligation_insert_failed');
    // both rows were minted (the second has no obligation) — both must supersede
    expect(h.rowInserts).toEqual([A, B]);
    const sql = new PgDialect().sqlToQuery(h.supersedeConds[0] as never);
    expect(sql.params).toHaveLength(2);
    // only the first obligation exists, and it is cancelled
    expect(h.insertedObligations).toHaveLength(1);
    expect(h.obligationConds).toHaveLength(1);
  });

  it('a first-insert failure (duplicate-submit collision) mints nothing and tears down nothing', async () => {
    h.failOnInsert = 1;
    await expect(openReviewRound('task-1', [A], 'result')).rejects.toThrow('insert_fk_miss');
    expect(h.rowInserts).toEqual([]);
    expect(h.supersedeSets).toEqual([]);
    expect(h.obligationConds).toEqual([]);
  });

  it('never cancels an obligation it did not create (an older live round owns it)', async () => {
    h.existingObligationId = 'obl-old-round';
    h.failOnInsert = 2;
    await expect(openReviewRound('task-1', [A, B], 'result')).rejects.toThrow('insert_fk_miss');
    expect(h.insertedObligations).toEqual([]);
    expect(h.obligationConds).toEqual([]);
  });
});

describe('openReviewRound reviewer-existence transaction (#364)', () => {
  it('locks the reviewer rows FOR KEY SHARE and inserts the round inside that same transaction', async () => {
    await openReviewRound('task-1', [A, B], 'result');
    expect(h.lockStrengths).toEqual(['key share']);
    expect(h.rowInserts).toEqual([A, B]);
    // every round/obligation insert ran inside the transaction the lock belongs to
    expect(h.insertInTx).toEqual([true, true, true, true]);
    expect(h.notes).toHaveLength(1);
  });

  it('a reviewer deleted inside the pre-check→lock window drops out — the survivors still open the round', async () => {
    h.deletedUsers = [B];
    const opened = await openReviewRound('task-1', [A, B], 'result');
    expect(opened).toMatchObject({ opened: 1, dropped: [B] });
    expect(h.rowInserts).toEqual([A]);
    // a drop is not a failure: nothing to supersede, no obligation cancelled
    expect(h.supersedeSets).toEqual([]);
    expect(h.obligationConds).toEqual([]);
  });

  it('every reviewer gone inside the window mints nothing and reports opened: 0 (the caller completes)', async () => {
    h.deletedUsers = [A, B];
    const opened = await openReviewRound('task-1', [A, B], 'result');
    expect(opened).toEqual({ round: 2, opened: 0, dropped: [A, B] });
    expect(h.rowInserts).toEqual([]);
    expect(h.insertedObligations).toEqual([]);
    expect(h.supersedeSets).toEqual([]);
    // nothing opened, so no round note may claim a round is waiting on reviewers
    expect(h.notes).toEqual([]);
  });
});
