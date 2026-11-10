import type { SQL } from 'drizzle-orm';
// TERMINAL ARBITRATION (#400): tasks.note's dispatch flip and tasks.ask's
// waiting-answer park are LIFECYCLE writes — both arbitrate on the status AND
// updatedAt stamp they read, like submit/answer/forward (#292 r1/r2). A note or
// question in flight across a terminal write (abandon, verdict settle, manual
// settle) must never resurrect the settled task: a lost note flip dispatches
// nothing (the note stays thread-only), a lost ask flip cancels/spawns NO
// obligation and refuses. The ask flip also runs BEFORE its obligation writes
// (OBLIGATION-CANCEL-AFTER-FLIP, #314 r1) — a lost flip touches zero rows.
//
// Vacuity: each lost-flip pin fails with the guard removed (the mock applies the
// flip only on a non-empty returning result, so an unguarded write still flips);
// the ordering pin fails if the obligation cancel moves back above the flip; the
// predicate pin renders the where and asserts column + operator + value.
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  flips: [] as Array<{ set: Record<string, unknown>; cond: unknown; txId: number | null }>,
  // the guarded-write arbiter: only a non-empty RETURNING means the flip won
  applied: true,
  // lose this many flip attempts (then win) — pins the retry-once path
  loseFlips: 0,
  txSeq: 0,
  // transaction ids observed by the obligation writes (TX-IDENTITY PIN LAW: a boolean
  // 'inside a transaction' flag cannot tell the caller's tx from a second one)
  obTxIds: [] as Array<number | null>,
  seq: [] as string[],
  dispatches: [] as string[],
  cancelled: [] as string[],
  spawned: [] as string[],
  notes: [] as unknown[],
  readAt: new Date('2026-11-10T09:00:00.000Z'),
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  // one update-builder factory for the pool and for each transaction: the applied()
  // result IS the arbiter (a lost guarded flip returns zero rows) and the captured
  // txId is what the TX-IDENTITY pin reads.
  const makeUpdate = (table: unknown, txId: number | null) => ({
    set: (set: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const applied = () => {
          h.flips.push({ set, cond, txId });
          h.seq.push('flip');
          const lose = !h.applied || h.loseFlips > 0;
          if (h.loseFlips > 0) h.loseFlips--;
          return table === tasks && !lose ? [{ id: 'task-1' }] : [];
        };
        return {
          returning: async () => applied(),
          then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
          catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
        };
      },
    }),
  });
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => {
        throw new Error('the note/ask paths must not use the select builder');
      },
      update: (table: unknown) => makeUpdate(table, null),
      transaction: async (fn: (tx: unknown) => unknown) => {
        const txId = ++h.txSeq;
        return fn({
          __tx: txId,
          update: (table: unknown) => makeUpdate(table, txId),
          select: () => {
            throw new Error('the note/ask paths must not use the select builder');
          },
          insert: () => ({ values: async () => {} }),
        });
      },
      query: {
        tasks: { findMany: async () => h.taskRows },
        taskStatuses: {
          // honor the caller's predicate (DB-mock predicate law)
          findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
            const id = args?.where?.id?.eq;
            return id ? h.statuses.filter((s) => s.id === id) : h.statuses;
          },
        },
        aiEmployees: { findFirst: async () => ({ userId: 'worker-1' }) },
      },
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    cancelObligations: async (_t: unknown, role: unknown, ex?: { __tx?: number }) => {
      h.cancelled.push(String(role));
      h.seq.push('cancel');
      h.obTxIds.push(ex?.__tx ?? null);
    },
    spawnObligation: async (_t: unknown, holder: string) => {
      h.spawned.push(String(holder));
      h.seq.push('spawn');
    },
    spawnObligationTracked: async (
      _t: unknown,
      holder: string,
      role: unknown,
      _at?: unknown,
      ex?: { __tx?: number },
    ) => {
      h.spawned.push(`${String(role)}:${holder}`);
      h.seq.push('spawn');
      h.obTxIds.push(ex?.__tx ?? null);
      return { id: 'ob-1', created: true };
    },
    resolveObligation: async () => {},
    answerHolder: async () => null,
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {}, hasOpenChildren: async () => false };
});

// FULL stub (never importOriginal): the real module's runner.service import cycles
// back into workflow.service and would cache the real bindings ahead of the mocks.
vi.mock('../../server/domains/tasks/review.service', () => ({
  logActivity: async () => {},
  currentRound: async () => 0,
  dedupeReviewers: (r: string[]) => r,
  dispatchedReviewRoundRow: async () => null,
  dispatchedReviewRound: async () => 0,
  openReviewRound: async () => {},
  openRoundLive: async () => false,
  dispatchAiReviewTurns: async () => {},
  recordVerdict: async () => {},
  listReviews: async () => [],
  parseEscalationNote: () => ({ targetName: null, why: '' }),
  escalateReview: async () => ({ outcome: 'parked' as const }),
  PARK_REARM_LADDER_MS: [300_000, 1_800_000, 7_200_000, 21_600_000],
  parkRound: async () => true,
  teardownOnManualMove: async () => {},
  teardownOpenRound: async () => {},
  verdictsSoFarFor: async () => [],
}));

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (...args: unknown[]) => {
      h.notes.push(args);
      h.seq.push('note');
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return { ...mod, steerRun: async () => 'stopped' };
});

vi.mock('../../server/domains/tasks/dispatcher.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/dispatcher.service')>();
  return {
    ...mod,
    dispatchIfEligible: async (taskId: string) => {
      h.dispatches.push(taskId);
      h.seq.push('dispatch');
      return true;
    },
  };
});

import { addNote, askQuestion } from '../../server/domains/tasks/workflow.service';

function seedWorkingAiTask() {
  h.taskRows = [
    {
      status: 'st-working',
      assigneeId: 'worker-1',
      ownerId: 'owner-1',
      createdBy: 'owner-1',
      questionChain: [],
      reviewers: [],
      updatedAt: h.readAt,
    },
  ];
  h.statuses = [{ id: 'st-working', category: CATEGORY.WORKING }];
}

function renderFlip() {
  const flip = h.flips[0];
  expect(flip, 'a flip was attempted').toBeDefined();
  return new PgDialect().sqlToQuery(flip?.cond as SQL);
}

beforeEach(() => {
  h.taskRows.length = 0;
  h.statuses.length = 0;
  h.flips = [];
  h.applied = true;
  h.loseFlips = 0;
  h.txSeq = 0;
  h.obTxIds = [];
  h.seq = [];
  h.dispatches = [];
  h.cancelled = [];
  h.spawned = [];
  h.notes = [];
});

describe('askQuestion parks before touching obligations (#400)', () => {
  it('a won ask flips first, then cancels/spawns the ANSWER obligation', async () => {
    seedWorkingAiTask();
    const res = await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(res).toEqual({ holderId: 'owner-1' });
    expect(h.seq).toEqual(['flip', 'cancel', 'spawn', 'note']);
    // the obligation ROLE is load-bearing: APPROVAL here would cancel a live review
    // round's approvals and park the owner with the wrong decision surface
    expect(h.cancelled).toEqual(['ANSWER']);
    expect(h.spawned).toEqual(['ANSWER:owner-1']);
    expect(h.flips[0]?.set.status).toBe(STATUS.waitingAnswer);
    expect(h.flips[0]?.set.questionChain).toEqual(['owner-1']);
    // TX-IDENTITY: the flip and BOTH obligation writes rode ONE transaction
    const ids = [h.flips[0]?.txId, ...h.obTxIds];
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeGreaterThan(0);
  });

  it('a lost ask flip cancels and spawns NOTHING and refuses', async () => {
    seedWorkingAiTask();
    h.applied = false;
    await expect(askQuestion('task-1', 'worker-1', 'late question')).rejects.toThrow(/state changed during ask/);
    // retry-once: two attempts, both lost — then the refusal
    expect(h.seq).toEqual(['flip', 'flip']);
    expect(h.flips).toHaveLength(2);
    expect(h.cancelled).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    expect(h.obTxIds).toHaveLength(0);
  });

  it('a benign concurrent write (one lost flip) re-reads and re-arbitrates instead of failing the settle', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    const res = await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(res).toEqual({ holderId: 'owner-1' });
    expect(h.flips).toHaveLength(2);
    // the losing attempt wrote nothing; the winning attempt's obligations rode ITS tx
    const winTx = h.flips[1]?.txId;
    expect(winTx).toBeGreaterThan(0);
    expect(h.obTxIds).toEqual([winTx, winTx]);
    expect(h.spawned).toEqual(['ANSWER:owner-1']);
    expect(h.seq).toEqual(['flip', 'flip', 'cancel', 'spawn', 'note']);
  });

  it('the ask flip pins id + the read status + the read updatedAt (operator + value)', () => {
    seedWorkingAiTask();
    h.applied = false;
    return askQuestion('task-1', 'worker-1', 'late question').then(
      () => {
        throw new Error('expected a refusal');
      },
      () => {
        const { sql, params } = renderFlip();
        // exact render: an `or(` swap makes the id conjunct alone match (the pre-#400
        // unguarded write) and every substring assertion would stay green
        expect(sql).toBe('(("tasks"."id" = $1) and ("tasks"."status" = $2) and ("tasks"."updated_at" = $3))');
        expect(params).toEqual(['task-1', 'st-working', h.readAt.toISOString()]);
      },
    );
  });
});

describe('addNote dispatch flip arbitrates on the read row (#400)', () => {
  it('a won note flip dispatches the run', async () => {
    seedWorkingAiTask();
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    expect(h.seq).toEqual(['note', 'flip', 'dispatch']);
    expect(h.flips[0]?.set.status).toBe(STATUS.todo);
  });

  it('a lost note flip dispatches nothing — the note stays thread-only', async () => {
    seedWorkingAiTask();
    h.applied = false;
    const res = await addNote('task-1', 'human-1', 'a note racing a settle');
    expect(res).toEqual({ steered: false });
    expect(h.dispatches).toHaveLength(0);
    expect(h.seq).toEqual(['note', 'flip']);
    expect(h.notes).toHaveLength(1);
  });

  it('the note flip pins id + the read status + the read updatedAt (operator + value)', async () => {
    seedWorkingAiTask();
    h.applied = false;
    await addNote('task-1', 'human-1', 'race');
    const { sql, params } = renderFlip();
    expect(sql).toBe('(("tasks"."id" = $1) and ("tasks"."status" = $2) and ("tasks"."updated_at" = $3))');
    expect(params).toEqual(['task-1', 'st-working', h.readAt.toISOString()]);
  });
});
