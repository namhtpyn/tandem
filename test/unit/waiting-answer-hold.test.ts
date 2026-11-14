// WAITING-ANSWER VERDICT HOLD (#288): waiting_answer owns the flow — a verdict
// settling while the task is parked on a question HOLDS the round instead of
// flipping the task: the settling row returns to PENDING, the ANSWER obligation
// and the waiting_answer status stay untouched, the flip's write-time gate now
// refuses waiting_answer-category statuses (a question landing inside the settle
// window can never be stomped), and the answer's unblock re-dispatches the held
// reviewer so the round settles normally on a live in-review task.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OBLIGATION_ROLE, CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  /** statuses served by taskStatuses.findMany (category map) */
  statuses: [] as Array<{ id: string; category: string }>,
  reviewRows: [] as Array<Record<string, unknown>>,
  matrixRows: [] as Array<Record<string, unknown>>,
  /** taskReviews read #3+: dispatchAiReviewTurns' pending-row read */
  pendingRows: [] as Array<Record<string, unknown>>,
  aiEmployees: [] as Array<{ userId: string }>,
  /** taskReviews UPDATEs in order: [0] = the verdict CAS, later = holds */
  reviewUpdates: [] as Array<{ set: Record<string, unknown>; where: unknown; inTx?: boolean; via?: string }>,
  /** tasks UPDATEs in order (settle flips) */
  taskUpdates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  casMiss: false,
  flipWins: true,
  resolved: [] as string[],
  cancelledAll: [] as string[],
  cancelled: [] as string[],
  spawned: [] as string[],
  dispatched: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  published: 0,
  txThrew: 0,
  inTx: false,
  reviewReadCounter: 0,
  taskReadCounter: 0,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskRuns } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      /** #467: the settle's sweep+flip ride ONE transaction. The double runs the
       *  callback against ITSELF; `txThrew` records a thrown callback, which is the
       *  real driver's ROLLBACK signal (a lost flip must never commit the sweep). */
      async transaction(this: Record<string, unknown>, fn: (tx: unknown) => Promise<unknown>) {
        h.inTx = true;
        // a DISTINCT tx handle whose `update` stamps itself 'tx': a write routed to the
        // POOL inside this callback is caught by the stamp, not by a boolean
        const tx = {
          ...this,
          update: (table: unknown) => (this.update as (t: unknown, via?: string) => unknown)(table, 'tx'),
        };
        try {
          return await fn(tx);
        } catch (e) {
          h.txThrew += 1;
          throw e;
        } finally {
          h.inTx = false;
        }
      },
      select: (...selArgs: Array<Record<string, unknown> | undefined>) => ({
        from: (table: unknown) => {
          const arg = selArgs[0] as Record<string, unknown> | undefined;
          // select-shape routing: {round} = currentRound, {resultBody} = roundResultBody,
          // bare = reviewer row / matrix / dispatch pending rows (in call order)
          const shape = arg
            ? arg.round !== undefined
              ? 'round'
              : arg.resultBody !== undefined
                ? 'body'
                : 'bare'
            : 'bare';
          const resolveRows = () => {
            // the settle's task-row lock selects { id } only — never a status read, so it
            // must not consume the ordered task-read sequence
            if (table === tasks && arg && 'id' in arg) return Promise.resolve([]);
            if (table === tasks) {
              // read order: [0] recordVerdict's terminal gate, [1] the hold arm's
              // fresh status, [2+] the hold's post-revert re-read / flip-miss re-check
              h.taskReadCounter += 1;
              const rows = h.taskRows;
              const at = Math.min(h.taskReadCounter - 1, rows.length - 1);
              return Promise.resolve([rows[at]!]);
            }
            if (table === taskRuns) return Promise.resolve([]); // no live review turns
            if (shape === 'round') return Promise.resolve([{ round: 2 }]);
            if (shape === 'body') return Promise.resolve([{ resultBody: undefined }]);
            h.reviewReadCounter += 1;
            const src =
              h.reviewReadCounter === 1 ? h.reviewRows : h.reviewReadCounter === 2 ? h.matrixRows : h.pendingRows;
            return Promise.resolve(src);
          };
          const mkRows = (): Record<string, unknown> => ({
            then: (
              onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) => resolveRows().then(onFulfilled, onRejected),
            catch: (onRejected: (e: unknown) => unknown) => resolveRows().catch(onRejected),
            // dispatchAiReviewTurns awaits .orderBy(col) bare (no limit) — the orderBy
            // chain must stay a rows-thenable too
            orderBy: () => mkRows(),
            // roundResultBody chains .limit(1) straight off .where(...)
            limit: async () => resolveRows(),
            for: () => mkRows(), // #467: the settle's task-row lock (SELECT ... FOR UPDATE)
          });
          const base = {
            where: (_cond: unknown) => mkRows(),
            // dispatchAiReviewTurns' live-turn check joins runs to messages — none running
            innerJoin: () => base,
          };
          return base;
        },
      }),
      update(this: Record<string, unknown>, table: unknown, via = 'pool') {
        return {
          set: (set: Record<string, unknown>) => ({
            where: (cond: unknown) => {
              const applied = () => {
                if (table === taskReviews) {
                  h.reviewUpdates.push({ set, where: cond, inTx: h.inTx, via });
                  if (h.casMiss && h.reviewUpdates.length === 1) return []; // the verdict CAS missed
                  return [{ id: 'row-1' }];
                }
                h.taskUpdates.push({ set, where: cond });
                return h.flipWins ? [{ id: 'task-1' }] : [];
              };
              return {
                // the hold revert awaits the where() directly (no .returning) — the
                // write must also record on the bare-await path, not only on returning()
                then: (
                  onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
                  onRejected?: (e: unknown) => unknown,
                ) => Promise.resolve(applied()).then(onFulfilled, onRejected),
                catch: (onRejected: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onRejected),
                returning: async () => applied(),
              };
            },
          }),
        };
      },
      query: {
        taskStatuses: {
          findMany: async () => h.statuses,
        },
        aiEmployees: {
          findMany: async () => h.aiEmployees,
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
    cancelObligations: async (_taskId: unknown, role: unknown) => {
      h.cancelled.push(String(role));
    },
    cancelAllObligations: async (_taskId: unknown, role: unknown) => {
      h.cancelledAll.push(String(role));
    },
    spawnObligation: async (_taskId: unknown, employeeId: unknown, role: unknown) => {
      h.spawned.push(`${String(role)}:${String(employeeId)}`);
      return 'obl-1';
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async (...args: unknown[]) => {
    h.dispatched.push(String(args[0]));
  },
}));

import { recordVerdict } from '../../server/domains/tasks/review.service';

const WAIT_STATUS = 'st-wait';

beforeEach(() => {
  h.taskRows = [{ status: WAIT_STATUS }];
  h.statuses = [
    { id: 'st-todo', category: CATEGORY.READY },
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: 'st-review', category: CATEGORY.IN_REVIEW },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: WAIT_STATUS, category: CATEGORY.WAITING_ANSWER },
    { id: 'st-done', category: CATEGORY.DONE },
    { id: 'st-cancelled', category: CATEGORY.CANCELLED },
  ];
  h.reviewRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
  h.matrixRows = [{ status: REVIEW_STATUS.APPROVED }, { status: REVIEW_STATUS.APPROVED }];
  h.reviewUpdates = [];
  h.taskUpdates = [];
  h.casMiss = false;
  h.flipWins = true;
  h.resolved = [];
  h.cancelledAll = [];
  h.cancelled = [];
  h.spawned = [];
  h.dispatched = [];
  h.pendingRows = [];
  h.aiEmployees = [];
  h.notes = [];
  h.published = 0;
  h.reviewReadCounter = 0;
  h.taskReadCounter = 0;
});

describe('waiting-answer verdict hold (#288)', () => {
  it('a unanimous approve arriving while waiting_answer parks the round: row held PENDING, no flip, obligation intact', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, 'looks fine', 'human');
    expect(outcome).toEqual({ outcome: 'parked' });
    // writes: [0] the verdict CAS (row decided), [1] the hold revert (row back to PENDING)
    expect(h.reviewUpdates).toHaveLength(2);
    expect(h.reviewUpdates[0]!.set.status).toBe(REVIEW_STATUS.APPROVED);
    const revert = h.reviewUpdates[1]!;
    expect(revert.set).toMatchObject({
      status: REVIEW_STATUS.PENDING,
      note: null,
      decidedAt: null,
      source: null,
    });
    expect(revert.where).not.toBeNull(); // the revert is a guarded write, never a blanket update
    // the task was NEVER flipped — no tasks-table write at all
    expect(h.taskUpdates).toHaveLength(0);
    // the ANSWER obligation was never cancelled (the reviewer's own APPROVAL
    // obligation resolving is the verdict CAS's normal side effect and stays)
    expect(h.cancelledAll).toHaveLength(0);
    // the held reviewer owes the vote again — the APPROVAL obligation re-spawns
    expect(h.spawned).toEqual([`${OBLIGATION_ROLE.APPROVAL}:rev-1`]);
    // the park note rode the thread and the change published
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.payload).toMatchObject({ reviewParked: true, round: 2 });
    expect(h.notes[0]!.body).toContain('waiting for an answer');
    expect(h.published).toBeGreaterThanOrEqual(1); // the hold publishes its change event
  });

  it('holds on every settle arm — a request_change from waiting_answer parks too', async () => {
    h.matrixRows = [{ status: REVIEW_STATUS.APPROVED }, { status: REVIEW_STATUS.REQUEST_CHANGE }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.REQUEST_CHANGE, '', 'human');
    expect(outcome).toEqual({ outcome: 'parked' });
    expect(h.taskUpdates).toHaveLength(0);
  });

  it('a question landing inside the settle window: the refused flip re-checks and parks instead of superseding', async () => {
    // gate + hold-arm reads see in_review (the question lands after the hold check,
    // inside the flip's write window — the write-time gate refuses the waiting_answer
    // status) and the miss-path re-check then sees waiting_answer
    h.taskRows = [{ status: 'st-review' }, { status: 'st-review' }, { status: WAIT_STATUS }];
    h.flipWins = false;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'parked' });
    // one refused flip attempt, then the hold revert. #467: the sweep rides the
    // transaction AHEAD of the flip, so a lost flip must ROLL IT BACK — the tx double
    // records the throw (h.txThrew) and the revert is the last committed review write.
    expect(h.taskUpdates).toHaveLength(1);
    expect(h.reviewUpdates.map((u) => u.set.status)).toEqual([
      REVIEW_STATUS.APPROVED,
      REVIEW_STATUS.SUPERSEDED,
      REVIEW_STATUS.PENDING,
    ]);
    // the sweep was written INSIDE the tx (so the throw rolled it back), and the revert
    // after it is the last committed write
    expect(h.reviewUpdates[1]!.via).toBe('tx'); // the STAMP, not an in-callback flag
    expect(h.reviewUpdates[2]!.via).toBe('pool');
    expect(h.txThrew).toBe(1);
  });

  it('IN-WINDOW RESCUE: an answer flipping the task to todo inside the hold window is repaired — guarded ready->in_review flip + re-fire', async () => {
    // reads: gate=waiting, hold=waiting (park wins), post-revert re-read=todo
    // (the answer's flip landed between the hold's read and the revert), then the
    // restore flip lands -> the mint's in-review gate read (#401) sees in_review
    h.taskRows = [{ status: WAIT_STATUS }, { status: WAIT_STATUS }, { status: 'st-todo' }, { status: 'st-review' }];
    h.pendingRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    h.aiEmployees = [{ userId: 'rev-1' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'parked' }); // held mid-flight, then resumed
    expect(h.reviewUpdates).toHaveLength(2); // verdict CAS + revert
    expect(h.spawned).toEqual([`${OBLIGATION_ROLE.APPROVAL}:rev-1`]);
    // exactly ONE guarded restore flip to in_review
    const restores = h.taskUpdates.filter((u) => u.set.status === STATUS.inReview);
    expect(restores).toHaveLength(1);
    expect(restores[0]!.where).not.toBeNull();
    // the held reviewer re-fired
    expect(h.dispatched).toEqual(['task-1']);
    // the round never parked — no PARK note (the re-fire logs its own activity line)
    expect(h.notes.some((n) => n.payload.reviewParked)).toBe(false);
  });

  it('IN-WINDOW RESCUE (already in_review): no flip, no re-fire — the flip writer owns the dispatch', async () => {
    h.taskRows = [
      { status: WAIT_STATUS },
      { status: WAIT_STATUS },
      { status: STATUS.inReview },
      { status: STATUS.inReview },
    ];
    h.pendingRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    h.aiEmployees = [{ userId: 'rev-1' }];
    await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(h.taskUpdates).toHaveLength(0); // no restore flip needed
    expect(h.dispatched).toEqual(['task-1']); // always re-fires: its row read runs after our revert
    expect(h.spawned).toEqual([`${OBLIGATION_ROLE.APPROVAL}:rev-1`]); // the decision surface re-arms
    expect(h.notes.some((n) => n.payload.reviewParked)).toBe(false);
    expect(h.published).toBeGreaterThanOrEqual(1); // the rescue publishes for live clients
  });

  it('an owner settle winning the hold window heals: reverted row supersedes, obligations cancel', async () => {
    // reads: gate=waiting, hold=waiting (the park wins), post-revert re-read=done
    // (the owner settled mid-window — teardown ran while our row was DECIDED)
    h.taskRows = [{ status: WAIT_STATUS }, { status: WAIT_STATUS }, { status: 'st-done' }, { status: 'st-done' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'parked' });
    // writes: CAS → revert (PENDING) → heal (SUPERSEDED); no tasks writes
    expect(h.reviewUpdates).toHaveLength(3);
    expect(h.reviewUpdates[1]!.set.status).toBe(REVIEW_STATUS.PENDING);
    expect(h.reviewUpdates[2]!.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.reviewUpdates[2]!.where).not.toBeNull();
    expect(h.taskUpdates).toHaveLength(0);
    // the spawn ran before the re-read — the heal's cancel removes whatever it inserted
    expect(h.spawned).toEqual([`${OBLIGATION_ROLE.APPROVAL}:rev-1`]);
    expect(h.cancelledAll).toEqual([OBLIGATION_ROLE.APPROVAL]);
    expect(h.notes).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.published).toBeGreaterThanOrEqual(1); // the heal publishes
  });

  it('a settle that RE-BLOCKED the task (paused, terminal home) still heals the held round (#423)', async () => {
    // the settle's re-gate can leave a settled task in a PAUSED block with a terminal
    // recorded home; a bare terminal-category check would leave our reverted row PENDING
    // and the approval obligation alive on a closed round
    h.statuses.push({ id: 'st-blocked', category: CATEGORY.PAUSED });
    h.taskRows = [
      { status: WAIT_STATUS },
      { status: WAIT_STATUS },
      { status: 'st-blocked', preBlockStatus: 'st-done' },
      { status: 'st-blocked', preBlockStatus: 'st-done' },
    ];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'parked' });
    expect(h.reviewUpdates).toHaveLength(3);
    expect(h.reviewUpdates[2]!.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.cancelledAll).toEqual([OBLIGATION_ROLE.APPROVAL]);
    expect(h.published).toBeGreaterThanOrEqual(1);
  });

  it('a working-category landing inside the window notes the thread (no flip, no re-fire)', async () => {
    h.taskRows = [{ status: WAIT_STATUS }, { status: WAIT_STATUS }, { status: 'st-doing' }, { status: 'st-doing' }];
    h.statuses.push({ id: 'st-doing', category: CATEGORY.WORKING });
    await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(h.taskUpdates).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    // the strand is documented: owner unblock re-fires once the RUN LOCK lifts
    expect(h.notes.some((n) => n.payload.reviewResumed)).toBe(true);
    expect(h.published).toBeGreaterThanOrEqual(1);
  });

  it('a flip lost to a plain concurrent settle still supersedes (hold arm only fires on waiting_answer)', async () => {
    h.taskRows = [{ status: 'st-review' }, { status: 'st-review' }, { status: 'st-review' }];
    h.flipWins = false;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.taskUpdates).toHaveLength(1); // the one refused flip, no park machinery
    expect(h.notes).toHaveLength(0);
  });

  it('answer → unblock → re-dispatch settles normally: a held round settles on a live in-review task', async () => {
    // phase 1: verdict lands while waiting_answer → held
    const held = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(held).toEqual({ outcome: 'parked' });
    // the answer lands: the task returns to in-review (the held row is PENDING
    // again — openRoundLive is true) and the holder's unblock re-dispatches
    h.taskRows = [{ status: 'st-review' }];
    h.reviewRows = [{ id: 'row-1', round: 2, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    h.reviewUpdates = [];
    h.taskUpdates = [];
    h.reviewReadCounter = 0;
    h.taskReadCounter = 0;
    // phase 2: the re-dispatched reviewer re-issues the verdict → settles
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.taskUpdates).toHaveLength(1);
    expect(h.taskUpdates[0]!.set.status).toBe(STATUS.done);
    expect(h.taskUpdates[0]!.where).not.toBeNull(); // the #260 CAS still guards the flip
    expect(h.cancelled.length).toBeGreaterThan(0); // the settle arm cancels APPROVAL obligations
    expect(h.notes[h.notes.length - 1]!.payload).toMatchObject({ approved: true, unanimous: true, round: 2 });
  });

  it('a non-waiting task settles exactly as before (hold arm is a no-op there)', async () => {
    h.taskRows = [{ status: 'st-review' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    // the verdict CAS + the terminal task-wide supersede (#365 r3 / #361 r6: no pending
    // row outlives a terminal task) — no hold revert
    // the verdict CAS + the in-tx sweep + the post-commit net (#361 r6): no pending row
    // outlives a terminal task, not even one minted while the settle tx was open
    expect(h.reviewUpdates).toHaveLength(3);
    expect(h.reviewUpdates[1]!.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.reviewUpdates[1]!.via).toBe('tx');
    expect(h.reviewUpdates[2]!.set.status).toBe(REVIEW_STATUS.SUPERSEDED);
    expect(h.reviewUpdates[2]!.via).toBe('pool');
    expect(h.taskUpdates[0]!.set.status).toBe(STATUS.done);
  });
});
