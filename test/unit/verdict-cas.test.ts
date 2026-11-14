// VERDICT CAS (#260): the verdict row write and every end-of-round task flip are
// conditional writes — the MANUAL SETTLE contract is enforced at WRITE time, not
// only by the pre-read gate. A manual settle that lands between the gate read and
// the writes must never be overridden: a torn-down row refuses the verdict, a
// won-row-but-lost-flip verdict stays recorded as audit history and keeps the
// owner's status (no settle-arm note, no publish).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  roundRows: [] as Array<Record<string, unknown>>,
  reviewRows: [] as Array<Record<string, unknown>>,
  matrixRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  casMiss: false,
  flipWins: true,
  updates: [] as Array<{
    table: string;
    set: Record<string, unknown>;
    hasPredicate: boolean;
    inTx: boolean;
    via: string;
  }>,
  resolved: [] as string[],
  cancelledAll: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  published: 0,
  txThrew: 0,
  txCalls: 0,
  inTx: false,
  txThrows: false,
  cancelThrows: false,
  taskReads: 0,
  lockTarget: '',
  lockMode: '',
  txArg: undefined as unknown,
  lockIndex: -1,
  cancelExec: [] as unknown[],
  readCounter: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      /** #467: the settle's sweep+flip ride ONE transaction. The double runs the
       *  callback against ITSELF; `txThrew` records a thrown callback, which is the
       *  real driver's ROLLBACK signal (a lost flip must never commit the sweep). */
      async transaction(this: Record<string, unknown>, fn: (tx: unknown) => Promise<unknown>) {
        h.txCalls += 1;
        h.inTx = true;
        // a DISTINCT tx handle whose `update` stamps itself 'tx': a write routed to the
        // POOL inside this callback is then caught by the stamp, not by a boolean
        const tx = {
          ...this,
          update: (table: unknown) => (this.update as (t: unknown, via?: string) => unknown)(table, 'tx'),
        };
        h.txArg = tx;
        try {
          if (h.txThrows) throw new Error('tx down');
          return await fn(tx);
        } catch (e) {
          h.txThrew += 1;
          throw e;
        } finally {
          h.inTx = false;
        }
      },
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => {
            const resolveRows = () => {
              if (table === tasks) {
                const at = Math.min(h.taskReads, h.taskRows.length - 1);
                h.taskReads += 1;
                return Promise.resolve([h.taskRows[at]!]);
              }
              // where-only taskReviews reads: 1st = the reviewer's row, 2nd = the matrix read
              h.readCounter += 1;
              return Promise.resolve(h.readCounter === 1 ? h.reviewRows : h.matrixRows);
            };
            const api: Record<string, unknown> = {
              then: (
                onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
                onRejected?: (e: unknown) => unknown,
              ) => resolveRows().then(onFulfilled, onRejected),
              catch: (onRejected: (e: unknown) => unknown) => resolveRows().catch(onRejected),
              orderBy: () => ({ limit: async () => h.roundRows }),
            };
            api.for = (mode?: string) => {
              h.lockIndex = h.updates.length; // #443: the lock must precede every write
              h.lockTarget = table === tasks ? 'tasks' : table === taskReviews ? 'taskReviews' : 'other';
              h.lockMode = mode ?? '';
              return api;
            };
            return api;
          },
        }),
      }),
      update(this: Record<string, unknown>, table: unknown, via = 'pool') {
        return {
          set: (set: Record<string, unknown>) => ({
            where: (cond: unknown) => ({
              returning: async () => {
                if (table === taskReviews) {
                  h.updates.push({ table: 'taskReviews', set, hasPredicate: cond != null, inTx: h.inTx, via });
                  return h.casMiss ? [] : [{ id: 'row-1' }];
                }
                h.updates.push({ table: 'tasks', set, hasPredicate: cond != null, inTx: h.inTx, via });
                return h.flipWins ? [{ id: 'task-1' }] : [];
              },
            }),
          }),
        };
      },
      query: {
        taskStatuses: {
          findMany: async () => h.statuses,
        },
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
    resolveObligation: async (...args: unknown[]) => {
      h.resolved.push(String(args[1]));
    },
    cancelObligations: async (_taskId: unknown, _role: unknown, ex: unknown) => {
      if (h.cancelThrows) throw new Error('cancel down');
      h.cancelExec.push(ex);
    },
    cancelAllObligations: async (_taskId: unknown, role: unknown, ex: unknown) => {
      h.cancelledAll.push(String(role));
      h.cancelExec.push(ex);
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
}));

import { recordVerdict } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskRows = [{ status: STATUS.inReview }];
  h.roundRows = [{ round: 2 }];
  h.reviewRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
  h.matrixRows = [{ status: REVIEW_STATUS.APPROVED }, { status: REVIEW_STATUS.APPROVED }];
  h.statuses = [
    { id: 'st-todo', category: CATEGORY.READY },
    { id: 'st-review', category: CATEGORY.IN_REVIEW },
    { id: 'st-done', category: CATEGORY.DONE },
    { id: 'st-cancelled', category: CATEGORY.CANCELLED },
  ];
  h.casMiss = false;
  h.flipWins = true;
  h.updates = [];
  h.resolved = [];
  h.cancelledAll = [];
  h.notes = [];
  h.published = 0;
  h.readCounter = 0;
  h.txThrew = 0;
  h.txCalls = 0;
  h.txThrows = false;
  h.cancelThrows = false;
  h.taskReads = 0;
  h.lockTarget = '';
  h.lockMode = '';
  h.inTx = false;
  h.txArg = undefined;
  h.lockIndex = -1;
  h.cancelExec = [];
});

describe('recordVerdict write-time guards (#260)', () => {
  it('a unanimous approve settles with BOTH writes conditional', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const rowWrite = h.updates.find((u) => u.table === 'taskReviews');
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(rowWrite?.hasPredicate).toBe(true);
    expect(rowWrite?.set.status).toBe(REVIEW_STATUS.APPROVED);
    expect(flip?.hasPredicate).toBe(true);
    expect(flip?.set.status).toBe(STATUS.done);
    expect(h.notes[0]?.payload).toMatchObject({ approved: true, unanimous: true, round: 2 });
  });

  it('a terminal settle flips and sweeps in ONE transaction, task row first (#467/#443)', async () => {
    // the fix's whole contract: if the sweep ran after the flip (or outside the tx), a
    // concurrent verdict CAS lands in the gap and is recorded into a round the settle
    // already closed. Sweep-first inside the tx makes that CAS wait on the row lock and
    // then fail its status=pending guard.
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.txCalls).toBe(1);
    // #443 LOCK ORDER: the task row is the tx's FIRST write, the sweep follows in the
    // same tx — a sweep-first order would cycle with abandon/round-open (40P01).
    const inTx = h.updates.filter((u) => u.via === 'tx'); // the STAMP, not an in-callback flag
    expect(inTx.map((u) => u.table)).toEqual(['taskReviews', 'tasks']); // sweep, THEN flip
    expect(inTx[0]!.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(inTx[1]!.set.status).toBe(STATUS.done);
    // #443 LOCK ORDER: the TASK row (never a review row) is locked FOR UPDATE before the
    // first write of the tx (the only earlier write is the verdict CAS, outside it)
    expect(h.lockIndex).toBe(h.updates.findIndex((u) => u.inTx));
    expect(h.lockTarget).toBe('tasks');
    expect(h.lockMode).toBe('update');
    expect(h.txThrew).toBe(0); // a won flip commits, never rolls back
    // the obligation cancel rides the SAME transaction (its executor IS the tx double):
    // a cancel left on the pool would survive a rollback and outlive the sweep it pairs with
    expect(h.cancelExec).toHaveLength(1);
    expect(h.cancelExec[0]).toBe(h.txArg);
  });

  it('the post-commit net sweeps again on the POOL after a won settle (#361 r6)', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const sweeps = h.updates.filter((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]!.via).toBe('tx'); // the atomic sweep
    expect(sweeps[1]!.via).toBe('pool'); // the net for a row minted while the tx was open
  });

  it('a failed transaction degrades to the pre-#467 order — the settle still lands', async () => {
    h.txThrows = true;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' }); // never a wedge behind a 500
    expect(h.txCalls).toBe(1);
    const taskWrites = h.updates.filter((u) => u.table === 'tasks');
    expect(taskWrites.at(-1)!.set.status).toBe(STATUS.done);
    expect(taskWrites.at(-1)!.via).toBe('pool'); // the degraded retry, outside any tx
    const sweeps = h.updates.filter((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.via).toBe('pool');
  });

  it('a failed cancel on the degraded path keeps the pending row as the heal signature', async () => {
    h.txThrows = true;
    h.cancelThrows = true;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' }); // the settle still lands
    // #397 r4 on the degraded path: cancel FIRST, sweep ONLY if it landed — a sweep here
    // would erase the pending row every residual heal keys on
    const sweeps = h.updates.filter((u) => u.table === 'taskReviews' && u.set.status === REVIEW_STATUS.SUPERSEDED);
    expect(sweeps).toHaveLength(0);
    expect(h.updates.filter((u) => u.table === 'tasks').at(-1)!.set.status).toBe(STATUS.done);
  });

  it('a client-side commit failure counts as WON when the task already carries the target status', async () => {
    // the tx committed server-side and threw on the ack: the pinned retry misses (the
    // stamp moved), and the status read says the settle DID land — the verdict note still
    // ships instead of reporting 'superseded' for a settle that happened
    h.txThrows = true;
    h.flipWins = false;
    h.taskRows = [{ status: STATUS.inReview }, { status: STATUS.inReview }, { status: STATUS.done }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.notes.length).toBeGreaterThan(0);
  });

  it('a teardown-superseded row makes the CAS miss — late verdict refused, task untouched', async () => {
    h.casMiss = true;
    await expect(recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human')).rejects.toThrow(
      'verdict already recorded for this round',
    );
    expect(h.updates.filter((u) => u.table === 'tasks')).toHaveLength(0);
    expect(h.resolved).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });

  it('a flip lost to a concurrent settle returns superseded — verdict row stays recorded, no settle-arm note', async () => {
    h.flipWins = false;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    const rowWrite = h.updates.find((u) => u.table === 'taskReviews');
    expect(rowWrite?.hasPredicate).toBe(true);
    const flip = h.updates.find((u) => u.table === 'tasks');
    expect(flip?.hasPredicate).toBe(true);
    expect(h.notes).toHaveLength(0);
    expect(h.published).toBe(0);
    // the approval cancel rode the transaction (identity), so the lost flip rolled it back
    expect(h.cancelExec[0]).toBe(h.txArg);
  });

  it('a unanimous reject cancels via the guarded flip', async () => {
    h.matrixRows = [{ status: REVIEW_STATUS.REJECTED }, { status: REVIEW_STATUS.REJECTED }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.REJECTED, '', 'human');
    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.cancelled);
    expect(h.cancelledAll.length).toBeGreaterThan(0);
  });
});
