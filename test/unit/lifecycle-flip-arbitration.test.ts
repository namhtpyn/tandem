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
// Vacuity: the mock arbitrates on a non-empty RETURNING result, so the lost-flip
// tests pin the CONTROL FLOW (a loss writes/dispatches nothing); the GUARD itself is
// pinned by the exact rendered-SQL assertions (column + operator + value — an `or(`
// swap or an id-only where fails them). The ordering pin fails if the obligation
// cancel moves back above the flip; the retry pins model a real row bump so a
// stale-read retry fails them.
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
  // model the CONCURRENT WRITE, not just a flag: a lost attempt bumps the row so a
  // retry that reuses the stale read is provably wrong (its CAS params stay stale)
  bumpOnLoss: false,
  reassignOnLoss: false,
  reownerOnLoss: false,
  statusOnLoss: null as string | null,
  steerStates: ['stopped'] as string[],
  steerCalls: 0,
  freshAt: new Date('2026-11-10T09:00:05.000Z'),
  txSeq: 0,
  // transaction ids observed by the obligation writes (TX-IDENTITY PIN LAW: a boolean
  // 'inside a transaction' flag cannot tell the caller's tx from a second one)
  obTxIds: [] as Array<number | null>,
  // key-share locks taken inside a transaction (lock-order pin) + the tx the
  // question ACTIVITY row rode (it must be the park's own tx)
  locks: [] as string[],
  lockedIds: [] as string[],
  lockedTables: [] as string[],
  missingHolder: false,
  missingAuthor: false,
  noteTxIds: [] as Array<number | null>,
  seq: [] as string[],
  dispatches: [] as string[],
  cancelled: [] as string[],
  spawned: [] as string[],
  notes: [] as unknown[],
  // NOTE-EGRESS ROUND TEARDOWN (#443): the dispatch flip resolves every open round in its
  // OWN transaction — recorded so the arbitration pins can also assert it rides the flip's
  // tx and never fires after a lost flip (a loser owns no round).
  teardowns: [] as Array<{ taskId: string; settledTo: string; txId: number | null }>,
  readAt: new Date('2026-11-10T09:00:00.000Z'),
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, user } = await import('../../server/db/schema');
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
          if (lose && h.bumpOnLoss) {
            h.taskRows[0] = {
              ...h.taskRows[0],
              updatedAt: h.freshAt,
              ...(h.reassignOnLoss ? { assigneeId: 'worker-2' } : {}),
              ...(h.reownerOnLoss ? { ownerId: 'owner-2' } : {}),
              ...(h.statusOnLoss ? { status: h.statusOnLoss } : {}),
            };
          }
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
          // the ask park key-shares the holder's user row before the tasks row
          select: () => ({
            from: (table: unknown) => ({
              where: (cond: unknown) => ({
                for: async (mode: string) => {
                  const { params } = new PgDialect().sqlToQuery(cond as SQL);
                  h.locks.push(String(mode));
                  h.lockedTables.push(table === user ? 'user' : 'other');
                  h.seq.push(`lock:${mode}`);
                  // every FK-referenced user row is locked in ONE statement
                  h.lockedIds = params.map((id) => String(id)).sort();
                  const ids = h.missingHolder ? params.slice(1) : h.missingAuthor ? params.slice(0, 1) : params;
                  return ids.map((id) => ({ id: String(id) }));
                },
              }),
            }),
          }),
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
  // #443: the dispatch flip resolves every open round inside its OWN transaction. The pin
  // is the TX IDENTITY (the teardown rode the flip's tx — in the real code a lost flip
  // throws and rolls that teardown back; a pool-level follow-up would leave a loser's
  // teardown committed), so the record carries the executor's tx id.
  teardownAllPendingRounds: async (taskId: string, settledTo: string, ex?: { __tx?: number }) => {
    h.teardowns.push({ taskId, settledTo, txId: ex?.__tx ?? null });
    h.seq.push('teardown');
  },
  verdictsSoFarFor: async () => [],
}));

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (input: unknown, ex?: { __tx?: number }) => {
      h.notes.push(input);
      h.seq.push('note');
      h.noteTxIds.push(ex?.__tx ?? null);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    steerRun: async () => h.steerStates[Math.min(h.steerCalls++, h.steerStates.length - 1)] ?? 'stopped',
  };
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
  h.bumpOnLoss = false;
  h.reassignOnLoss = false;
  h.reownerOnLoss = false;
  h.statusOnLoss = null;
  h.steerStates = ['stopped'];
  h.steerCalls = 0;
  h.txSeq = 0;
  h.obTxIds = [];
  h.locks = [];
  h.lockedIds = [];
  h.lockedTables = [];
  h.missingHolder = false;
  h.missingAuthor = false;
  h.noteTxIds = [];
  h.seq = [];
  h.dispatches = [];
  h.cancelled = [];
  h.spawned = [];
  h.notes = [];
  h.teardowns = [];
});

describe('askQuestion parks before touching obligations (#400)', () => {
  it('a won ask flips first, then cancels/spawns the ANSWER obligation', async () => {
    seedWorkingAiTask();
    const res = await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(res).toEqual({ holderId: 'owner-1' });
    // the lock is taken BEFORE the flip, in KEY SHARE mode
    expect(h.seq).toEqual(['lock:key share', 'flip', 'cancel', 'spawn', 'note']);
    // the obligation ROLE is load-bearing: APPROVAL here would cancel a live review
    // round's approvals and park the owner with the wrong decision surface
    expect(h.cancelled).toEqual(['ANSWER']);
    expect(h.spawned).toEqual(['ANSWER:owner-1']);
    expect(h.flips[0]?.set.status).toBe(STATUS.waitingAnswer);
    expect(h.flips[0]?.set.questionChain).toEqual(['owner-1']);
    // TX-IDENTITY: the flip, BOTH obligation writes AND the question row rode ONE tx
    const ids = [h.flips[0]?.txId, ...h.obTxIds, ...h.noteTxIds];
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeGreaterThan(0);
    // LOCK ORDER: both FK-referenced user rows (holder + author) are key-shared in ONE
    // statement before the tasks flip — never a user lock after the task row
    expect(h.locks).toEqual(['key share']);
    expect(h.seq[0]).toBe('lock:key share');
    // BOTH FK-referenced rows — the holder (obligation) and the author (question row) —
    // and the USER table, not some other table carrying a matching predicate
    expect(h.lockedIds).toEqual(['owner-1', 'worker-1']);
    expect(h.lockedTables).toEqual(['user']);
  });

  it('a lost ask flip cancels and spawns NOTHING and refuses', async () => {
    seedWorkingAiTask();
    h.applied = false;
    await expect(askQuestion('task-1', 'worker-1', 'late question')).rejects.toThrow(/state changed during ask/);
    // retry-once: two attempts, both lost — then the refusal
    expect(h.seq).toEqual(['lock:key share', 'flip', 'lock:key share', 'flip']);
    expect(h.flips).toHaveLength(2);
    expect(h.cancelled).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    expect(h.obTxIds).toHaveLength(0);
  });

  it('a benign concurrent write (one lost flip) re-reads and re-arbitrates on the FRESH stamp', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    h.bumpOnLoss = true; // the row really changed — a stale-read retry would miss again
    const res = await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(res).toEqual({ holderId: 'owner-1' });
    expect(h.flips).toHaveLength(2);
    // the winning CAS arbitrates on the RE-READ stamp, not the attempt-0 one
    const win = new PgDialect().sqlToQuery(h.flips[1]?.cond as SQL);
    expect(win.params[2]).toBe(h.freshAt.toISOString());
    // the losing attempt wrote nothing; the winning attempt's obligations rode ITS tx
    const winTx = h.flips[1]?.txId;
    expect(winTx).toBeGreaterThan(0);
    expect(h.obTxIds).toEqual([winTx, winTx]);
    expect(h.spawned).toEqual(['ANSWER:owner-1']);
    expect(h.seq).toEqual(['lock:key share', 'flip', 'lock:key share', 'flip', 'cancel', 'spawn', 'note']);
  });

  it('a reassignment in the retry window still parks the question (authority decided on the first read)', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.reassignOnLoss = true; // the run's assignee is no longer the task's assignee
    const res = await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(res).toEqual({ holderId: 'owner-1' });
    expect(h.spawned).toEqual(['ANSWER:owner-1']);
    expect(h.notes).toHaveLength(1);
  });

  it('an owner change inside the retry window parks the question on the CURRENT owner', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.reownerOnLoss = true;
    const res = await askQuestion('task-1', 'worker-1', 'who signs off?');
    expect(res).toEqual({ holderId: 'owner-2' });
    expect(h.flips[1]?.set.questionChain).toEqual(['owner-2']);
    expect(h.spawned).toEqual(['ANSWER:owner-2']);
  });

  it('a same-category status move is re-read too — the retry CASes the FRESH status id', async () => {
    seedWorkingAiTask();
    h.statuses.push({ id: 'st-working-2', category: CATEGORY.WORKING });
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.statusOnLoss = 'st-working-2';
    await askQuestion('task-1', 'worker-1', 'which scope?');
    const win = new PgDialect().sqlToQuery(h.flips[1]?.cond as SQL);
    expect(win.params[1]).toBe('st-working-2');
    expect(win.params[2]).toBe(h.freshAt.toISOString());
  });

  it('a holder deleted mid-settle is a LOST attempt — the retry re-reads, never a hard failure', async () => {
    seedWorkingAiTask();
    h.missingHolder = true; // the key-share returns only the author row
    await expect(askQuestion('task-1', 'worker-1', 'who signs off?')).rejects.toThrow(/state changed during ask/);
    // both attempts were made (the lock refuses before any write) and nothing landed
    expect(h.locks).toEqual(['key share', 'key share']);
    expect(h.flips).toHaveLength(0);
    expect(h.cancelled).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });

  it('a vanished AUTHOR is a lost attempt too — never a raw FK error from the question row', async () => {
    seedWorkingAiTask();
    h.missingAuthor = true;
    await expect(askQuestion('task-1', 'worker-1', 'who signs off?')).rejects.toThrow(/state changed during ask/);
    expect(h.flips).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
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
    // #443: the open-round teardown runs INSIDE the flip's transaction, after the CAS —
    // the task row is the transaction's first write (abandonTask's order), so no writer
    // can cycle on a review row this tx holds. A lost CAS writes nothing at all.
    expect(h.seq).toEqual(['note', 'flip', 'teardown', 'dispatch']);
    expect(h.flips[0]?.set.status).toBe(STATUS.todo);
    expect(h.teardowns).toHaveLength(1);
    expect(h.teardowns[0]?.txId).toBe(h.flips[0]?.txId);
  });

  it('a lost note flip caused by a DISPATCH CLAIM never re-flips the claimed row', async () => {
    // the claim commits ready -> working BEFORE its RUNNING run row exists, so the
    // steer gate still reports 'stopped' — the retry must not flip it back to to-do
    seedWorkingAiTask();
    h.taskRows[0] = { ...h.taskRows[0], status: 'st-todo' };
    h.statuses = [
      { id: 'st-todo', category: CATEGORY.READY },
      { id: 'st-doing', category: CATEGORY.WORKING },
    ];
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.statusOnLoss = 'st-doing'; // the dispatcher's claim
    h.steerStates = ['stopped', 'stopped'];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false });
    // the retry DID consult the composer's steer gate before giving up
    expect(h.steerCalls).toBe(2);
    expect(h.flips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a claimed row whose run is already visible takes the note as a STEER', async () => {
    seedWorkingAiTask();
    h.taskRows[0] = { ...h.taskRows[0], status: 'st-todo' };
    h.statuses = [
      { id: 'st-todo', category: CATEGORY.READY },
      { id: 'st-doing', category: CATEGORY.WORKING },
    ];
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.statusOnLoss = 'st-doing';
    h.steerStates = ['stopped', 'steered']; // the claim's RUNNING row is now visible
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: true });
    expect(h.flips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a manual status move in the retry window is never overwritten (winner owns the row)', async () => {
    seedWorkingAiTask();
    h.statuses.push({ id: 'st-paused', category: CATEGORY.PAUSED });
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.statusOnLoss = 'st-paused';
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false });
    expect(h.flips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a retry that finds an EXCLUDED category still steers a live run first', async () => {
    seedWorkingAiTask();
    h.statuses.push({ id: 'st-review', category: CATEGORY.IN_REVIEW });
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    h.statusOnLoss = 'st-review'; // a submit opened the review round
    h.steerStates = ['stopped', 'steered']; // ...and its reviewer turn is live
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: true });
    expect(h.flips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a lost note flip that finds a LIVE run steers it instead of flipping', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    h.steerStates = ['stopped', 'steered'];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: true });
    expect(h.flips).toHaveLength(1);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a lost note flip dispatches nothing — the note stays thread-only', async () => {
    seedWorkingAiTask();
    h.applied = false;
    const res = await addNote('task-1', 'human-1', 'a note racing a settle');
    expect(res).toEqual({ steered: false });
    expect(h.dispatches).toHaveLength(0);
    // retry-once: two attempts, both lost — and NO teardown: a lost CAS wrote nothing, so
    // the winner's round is never touched (#443)
    expect(h.seq).toEqual(['note', 'flip', 'flip']);
    expect(h.teardowns).toHaveLength(0);
    expect(h.notes).toHaveLength(1);
  });

  it('a benign concurrent write retries the dispatch flip once on the fresh stamp', async () => {
    seedWorkingAiTask();
    h.loseFlips = 1;
    h.bumpOnLoss = true;
    const res = await addNote('task-1', 'human-1', 'send');
    expect(res).toEqual({ steered: false, dispatched: true });
    expect(h.flips).toHaveLength(2);
    const win = new PgDialect().sqlToQuery(h.flips[1]?.cond as SQL);
    expect(win.params[2]).toBe(h.freshAt.toISOString());
    expect(h.dispatches).toEqual(['task-1']);
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
