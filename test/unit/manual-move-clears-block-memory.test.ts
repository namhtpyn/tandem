// MACHINE-BLOCK MEMORY (#401): the owner's manual status move is the verdict of record,
// so it clears BOTH machine origins — park_from_status (a review park) and
// pre_block_status (a gating auto-block). Before this, a pre_block_status left behind by
// an old auto-block survived the manual move, and a later hand-made block therefore
// looked machine-recorded to the settle flip's carve-out: a closing verdict could flip a
// task the owner had parked by hand, the exact #401 harm. Clearing it also keeps a fresh
// auto-block's restore target honest (gating records the CURRENT status, never a stale
// origin).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  sets: [] as Array<Record<string, unknown>>,
  txSeq: 0,
  /** the tx id the status UPDATE landed on, and the tx id the activity row landed on */
  updateTx: 0,
  logTx: 0,
  /** what the real logActivity built and where it sent it (the probe's contract) */
  logKind: '',
  logBody: '',
  /** ordered writes inside the transaction: the actor lock must precede the task write */
  ops: [] as string[],
  /** when true, the pre-lock finds no actor row (a concurrent employee delete) */
  actorGone: false,
  /** flips ONLY when the transaction helper resolved — the commit of record (#438 r2) */
  committed: false,
  /** post-commit side-effect invocations, in handler order */
  sideFx: [] as string[],
  /** when true, the named post-commit side effect throws (the SPEC's can't-erase case) */
  throwTeardown: false,
  throwResume: false,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, user } = await import('../../server/db/schema');
  // every transaction gets its OWN id: a boolean "inside a transaction" flag cannot tell
  // the caller's transaction from a second one (TX-IDENTITY pin law)
  const makeTx = () => {
    const id = ++h.txSeq;
    return {
      __tx: id,
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            // thread BOTH arguments: a `from(tasks)` or `for('update')` mutant must show
            // up as a different op (the pin exists to catch exactly that inversion)
            for: async (strength: string) => {
              h.ops.push(`lock:${table === user ? 'user' : 'other'}:${strength}`);
              return h.actorGone ? [] : [{ id: 'u1' }];
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          if (table === tasks) {
            h.sets.push(set);
            h.updateTx = id;
            h.ops.push('update-task');
          }
          return { where: async () => undefined };
        },
      }),
    };
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {
        tasks: { findMany: async () => h.taskRows },
        taskStatuses: {
          findMany: async () => [{ id: STATUS.todo, category: 'ready' }],
          findFirst: async () => ({ id: STATUS.todo }),
        },
      },
      // a move written OUTSIDE the transaction helper must be visible as tx 0 (a pin)
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = makeTx();
        const out = await fn(tx);
        // the commit of record: flipped only when the tx helper RESOLVED — a side effect
        // that sees this false ran before the owner-move record landed (#438 r2 pin)
        h.committed = true;
        return out;
      },
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return { ...mod, runningRunIdForTask: async () => null };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  // logActivity stays REAL: the pin must observe the activity row the writer actually
  // builds (body + kind) and the executor it actually forwards — not a re-implementation
  return {
    ...mod,
    teardownOnManualMove: async () => {
      h.sideFx.push('teardown');
      // #438 r2: SPEC — "the teardown/resume side effects run AFTER that commit, so their
      // failure can never erase it". The committed flag is checked INSIDE the mock: a
      // handler reorder that hoists a side effect above the transaction fails HERE, with
      // the ordering violation as the message, before any outer assertion can misread it.
      if (!h.committed) throw new Error('SIDE EFFECT BEFORE COMMIT: teardown ran before the owner-move tx resolved');
      if (h.throwTeardown) throw new Error('teardown exploded (pin)');
    },
  };
});

// the terminal write of the real logActivity — capture its input AND its executor, so a
// dropped `ex` (a write on the pool connection instead of the transaction) goes red
vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (input: { body: string; payload: Record<string, unknown> }, ex?: unknown) => {
      h.logKind = String(input.payload.kind);
      h.logBody = input.body;
      h.logTx = (ex as { __tx?: number } | undefined)?.__tx ?? 0;
    },
  };
});

vi.mock('../../server/domains/tasks/review-resume', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review-resume')>();
  return {
    ...mod,
    resumeRoundAfterManualMove: async () => {
      h.sideFx.push('resume');
      // same committed-check discipline as the teardown mock above (#438 r2)
      if (!h.committed) throw new Error('SIDE EFFECT BEFORE COMMIT: resume ran before the owner-move tx resolved');
      if (h.throwResume) throw new Error('resume exploded (pin)');
      return false;
    },
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => undefined };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { tasksRouter } from '#server/domains/tasks/tasks.router';

import { call } from './helpers/call';

beforeEach(() => {
  h.taskRows = [{ status: STATUS.inReview, parentTaskId: null }];
  h.sets = [];
  h.updateTx = 0;
  h.logTx = 0;
  h.logKind = '';
  h.logBody = '';
  h.ops = [];
  h.actorGone = false;
  h.committed = false;
  h.sideFx = [];
  h.throwTeardown = false;
  h.throwResume = false;
});

describe('a manual status move clears the machine block memory (#401)', () => {
  it('clears park_from_status, pre_block_status and the re-arm ladder', async () => {
    await call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]?.status).toBe(STATUS.todo);
    expect(h.sets[0]?.parkFromStatus).toBeNull();
    expect(h.sets[0]?.preBlockStatus).toBeNull();
    expect(h.sets[0]?.parkRearmAttempts).toBe(0);
  });

  // OWNER-MOVE RECORD (#430): the activity row the prod probe reads to tell an owner move
  // from a machine status write commits in the SAME transaction as the status write — a
  // landed move must never exist without it (the teardown/resume side effects run after).
  it('writes the owner-move activity row in the same transaction as the status write', async () => {
    await call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo });
    expect(h.updateTx).toBeGreaterThan(0);
    expect(h.logTx, 'the activity row must ride the status write transaction').toBe(h.updateTx);
  });

  // The probe's manual-freedom discriminator is `body LIKE 'status: %'` + payload
  // kind='STATUS'. A wording/kind refactor here would silently disarm the watchdog, so
  // the WRITER's bytes are pinned against the READER's contract.
  it('records the exact body prefix and activity kind the probe reads', async () => {
    await call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo });
    expect(h.logKind).toBe('STATUS');
    expect(h.logBody).toBe(`status: ${STATUS.inReview} → ${STATUS.todo}`);
  });

  // LOCK ORDER (#430): the actor's user row is locked BEFORE the task row — an employee
  // delete holds that row FOR UPDATE and then cascades into tasks, so the reverse order
  // is a 40P01 deadlock with a concurrent offboarding.
  it('takes the actor user-row lock before the task write', async () => {
    await call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo });
    expect(h.ops).toEqual(['lock:user:key share', 'update-task']);
  });

  // THE ONLY-WRITER PREMISE: the probe treats `tasks.setStatus` as the only manual status
  // writer. The adjacent task write surface must keep refusing a status key — if
  // `tasks.update` ever learned to move status, a manual move could land unrecorded and
  // the watchdog would go blind (or false-alarm) with every test still green.
  it('the adjacent task update surface still refuses a status key', async () => {
    await expect(call(tasksRouter.update, { id: 'task-1', status: STATUS.todo })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  // A vanished actor is a LOST attempt (#400), never a raw FK error: the pre-lock sees an
  // empty row set and the handler refuses cleanly with nothing written.
  it('refuses cleanly when the acting user row vanished', async () => {
    h.actorGone = true;
    await expect(call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.sets).toHaveLength(0);
  });
});

// #438 r2 (blind review, spec lens): SPEC — "the teardown/resume side effects run AFTER
// that commit, so their failure can never erase it". Until now both side effects were
// mocked as silent no-ops, so nothing failed when a reorder hoisted them above the
// transaction, or when the activity row drifted off the tx. A THROWING side effect is
// the red-making mutation: the record of the move must already be durable.
describe('a throwing post-commit side effect cannot erase the owner-move record (#438)', () => {
  it('a throwing teardown rejects the move but leaves the committed record intact', async () => {
    h.throwTeardown = true;
    await expect(call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo })).rejects.toThrow(
      'teardown exploded (pin)',
    );
    // the tx helper resolved BEFORE the side effect was reached — the mock's internal
    // committed-check would have thrown 'SIDE EFFECT BEFORE COMMIT' on any reorder
    expect(h.committed).toBe(true);
    // the status write and its activity row landed on the SAME committed transaction
    expect(h.updateTx).toBeGreaterThan(0);
    expect(h.logTx, 'the activity row must ride the status write transaction').toBe(h.updateTx);
    expect(h.sideFx).toContain('teardown');
  });

  it('a throwing resume rejects the move but leaves the committed record intact too', async () => {
    h.throwResume = true;
    await expect(call(tasksRouter.setStatus, { id: 'task-1', status: STATUS.todo })).rejects.toThrow(
      'resume exploded (pin)',
    );
    expect(h.committed).toBe(true);
    expect(h.updateTx).toBeGreaterThan(0);
    expect(h.logTx).toBe(h.updateTx);
    // BOTH post-commit side effects ran (in handler order) and both saw committed=true:
    // the resume is the second one, so reaching it proves the teardown already passed
    expect(h.sideFx).toEqual(['teardown', 'resume']);
  });
});
