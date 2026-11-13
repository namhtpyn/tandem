// COMPOSER LAW server truth (#265): tasks.note's dispatch exclusion keys off the
// status CATEGORY — every non-terminal, non-in-review task with an AI assignee
// dispatches (the send flips the status to to-do and fires the run). The old
// check compared SEEDED status ids, so a custom done/cancelled/in-review status
// dispatched on send (and the UI could never mirror the rule). Pinned here:
// custom terminal/in-review statuses refuse, working/blocked categories dispatch,
// humans never dispatch, and a steered live run returns before any flip.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  aiEmployees: [] as Array<Record<string, unknown>>,
  steerState: 'stopped' as 'steered' | 'stopped' | 'refused',
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  dispatches: [] as string[],
  dispatchOk: true,
  notes: [] as unknown[],
  published: 0,
  // #443: the marker executor the mock transaction hands its callback, and the teardown
  // calls the review module received
  tx: { marker: 'tx' } as Record<string, unknown>,
  teardowns: [] as Array<{
    taskId: string;
    settledTo: string;
    ex: unknown;
    opts?: { publish?: boolean; reason?: 'egress' };
  }>,
  teardownThrows: false,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  const api = {
    select: () => {
      throw new Error('addNote must not use the select builder');
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const applied = () => {
            h.updates.push({ table: table === tasks ? 'tasks' : 'other', set });
            return [{ id: 'task-1' }];
          };
          return {
            returning: async () => applied(),
            then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
            catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
          };
        },
      }),
    }),
    query: {
      tasks: { findMany: async () => h.taskRows },
      taskStatuses: { findMany: async () => h.statuses },
      aiEmployees: { findFirst: async () => h.aiEmployees[0] ?? null },
    },
  };
  // NOTE-EGRESS ROUND TEARDOWN (#443): the dispatch flip runs in a transaction and the
  // round teardown joins it. The tx executor carries the same builders plus a marker, so
  // the specs can assert the teardown received the flip's OWN executor — not the pool db.
  const tx = { ...api, __tx: true };
  h.tx = tx;
  return {
    asDb: (x: unknown) => x,
    db: { ...api, transaction: async (fn: (ex: unknown) => unknown) => fn(tx) },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => void h.published++ };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return { ...mod, spawnObligation: async () => {}, resolveObligation: async () => {} };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {}, hasOpenChildren: async () => false };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    // #443: the note-dispatch flip must resolve every open round inside its own
    // transaction; recorded here so the specs assert the call, its executor and its
    // publish/body contract. A THROW simulates the teardown failing: the flip's
    // transaction rolls back and no dispatch may fire (the note stays thread-only).
    teardownAllPendingRounds: async (
      taskId: string,
      settledTo: string,
      ex?: unknown,
      opts?: { publish?: boolean; reason?: 'egress' },
    ) => {
      h.teardowns.push({ taskId, settledTo, ex, opts });
      if (h.teardownThrows) throw new Error('round teardown exploded');
    },
  };
});

// workflow.service's logActivity routes through thread.service (the thread IS the
// activity store) — record at the insert seam
vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async (...args: unknown[]) => void h.notes.push(args) };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return { ...mod, steerRun: async () => h.steerState };
});

vi.mock('../../server/domains/tasks/dispatcher.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/dispatcher.service')>();
  return {
    ...mod,
    dispatchIfEligible: async (taskId: string) => {
      h.dispatches.push(taskId);
      return h.dispatchOk;
    },
  };
});

import { addNote } from '../../server/domains/tasks/workflow.service';

function seedTask(statusId: string, assigneeId: string | null) {
  h.taskRows = [
    { status: statusId, assigneeId, ownerId: 'owner-1', createdBy: 'owner-1', questionChain: [], reviewers: [] },
  ];
}

beforeEach(() => {
  h.taskRows.length = 0;
  h.statuses.length = 0;
  h.dispatchOk = true;
  h.updates = [];
  h.dispatches = [];
  h.notes = [];
  h.published = 0;
  h.steerState = 'stopped';
  h.teardowns = [];
  h.teardownThrows = false;
  h.aiEmployees = [{ userId: 'worker-1' }];
});

describe('tasks.note dispatch rule keys off the category (#265)', () => {
  it('a working-category AI task flips to to-do and dispatches', async () => {
    seedTask('st-custom-working', 'worker-1');
    h.statuses = [{ id: 'st-custom-working', category: CATEGORY.WORKING }];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    expect(h.updates.find((u) => u.table === 'tasks')?.set.status).toBe(STATUS.todo);
    expect(h.dispatches).toEqual(['task-1']);
  });

  it('a silently-skipped dispatch (pending backoff / agent at cap) never claims dispatched (r5)', async () => {
    seedTask('st-custom-working', 'worker-1');
    h.statuses = [{ id: 'st-custom-working', category: CATEGORY.WORKING }];
    h.dispatchOk = false;
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false });
    expect(h.dispatches).toEqual(['task-1']);
    h.dispatchOk = true;
  });

  it('a blocked/paused-category AI task dispatches too — the rule is not ready-only', async () => {
    seedTask('st-custom-blocked', 'worker-1');
    h.statuses = [{ id: 'st-custom-blocked', category: CATEGORY.PAUSED }];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    expect(h.dispatches).toEqual(['task-1']);
  });

  // EGRESS EXHAUSTION (#427): the note-dispatch bounce is a legal egress from a block —
  // the dispatch flip must exhaust the round's machine memory in the SAME write, or the
  // parked home survives on a to-do row and the spent re-arm ladder is handed to the
  // task's next park (parkRound INCREMENTS a surviving ledger → mid-ladder or FINAL).
  it('the dispatch flip from a blocked task clears both origins and the ladder (#427)', async () => {
    seedTask('st-custom-blocked', 'worker-1');
    h.statuses = [{ id: 'st-custom-blocked', category: CATEGORY.PAUSED }];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    const writes = h.updates.filter((u: { table: string }) => u.table === 'tasks');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.set).toMatchObject({
      status: STATUS.todo,
      preBlockStatus: null,
      parkFromStatus: null,
      parkRearmAttempts: 0,
      parkRearmAfter: null,
    });
  });

  // the WORKING-category send rides the same write — the clearing is unconditional on
  // egress (a non-blocked row must never carry an origin, #423), so no branch can skip it
  it('the dispatch flip from a working task clears origins too — the clear is not block-gated (#427)', async () => {
    seedTask('st-custom-working', 'worker-1');
    h.statuses = [{ id: 'st-custom-working', category: CATEGORY.WORKING }];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    const writes = h.updates.filter((u: { table: string }) => u.table === 'tasks');
    expect(writes[0]?.set).toMatchObject({
      preBlockStatus: null,
      parkFromStatus: null,
      parkRearmAttempts: 0,
      parkRearmAfter: null,
    });
  });

  // NOTE-EGRESS ROUND TEARDOWN (#443): a send on a PARKED task is an egress from a review
  // park — its PENDING reviewer row sat on a paused task no sweep can reach (the
  // stalled-review and lost-settle scans require review-flow ownership), so the flip must
  // resolve the round in the SAME transaction: the task returns to work and the parked
  // round's verdict would judge superseded work. Pinned: the teardown rides the flip's
  // executor, targets the ready status the flip lands, defers its change events to the
  // post-commit note, and a teardown failure blocks the dispatch.
  it('the dispatch flip from a parked task tears its open rounds down in the same transaction (#443)', async () => {
    seedTask('st-custom-blocked', 'worker-1');
    h.statuses = [{ id: 'st-custom-blocked', category: CATEGORY.PAUSED }];
    const res = await addNote('task-1', 'human-1', 'go');
    expect(res).toEqual({ steered: false, dispatched: true });
    expect(h.teardowns).toHaveLength(1);
    expect(h.teardowns[0]).toMatchObject({ taskId: 'task-1', settledTo: STATUS.todo });
    // the SAME executor the flip wrote through — one transaction, not a follow-up write
    expect((h.teardowns[0]?.ex as { __tx?: boolean } | undefined)?.__tx).toBe(true);
    // a redis publish must never gate the held task row lock: the row is written in the
    // tx and the event rides the post-commit note
    expect(h.teardowns[0]?.opts?.publish).toBe(false);
    expect(h.teardowns[0]?.opts?.reason).toBe('egress');
  });

  it('a teardown failure aborts the flip and the dispatch — nothing lands (#443)', async () => {
    seedTask('st-custom-blocked', 'worker-1');
    h.statuses = [{ id: 'st-custom-blocked', category: CATEGORY.PAUSED }];
    h.teardownThrows = true;
    await expect(addNote('task-1', 'human-1', 'go')).rejects.toThrow('round teardown exploded');
    expect(h.dispatches).toHaveLength(0);
  });

  it('a CUSTOM done-category status refuses — category vocabulary, never seeded ids', async () => {
    seedTask('st-custom-done', 'worker-1');
    h.statuses = [{ id: 'st-custom-done', category: CATEGORY.DONE }];
    const res = await addNote('task-1', 'human-1', 'note');
    expect(res).toEqual({ steered: false });
    expect(h.updates).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a waiting_answer-category task is thread-only — no flip, no dispatch (#314, mirrors noteWillDispatch)', async () => {
    seedTask('st-custom-wait', 'worker-1');
    h.statuses = [{ id: 'st-custom-wait', category: CATEGORY.WAITING_ANSWER }];
    const res = await addNote('task-1', 'human-1', 'a note while waiting');
    expect(res).toEqual({ steered: false });
    expect(h.updates).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
  });

  it('custom cancelled- and in-review-category statuses refuse as well', async () => {
    for (const [id, category] of [
      ['st-custom-cancelled', CATEGORY.CANCELLED],
      ['st-custom-review', CATEGORY.IN_REVIEW],
    ] as const) {
      seedTask(id, 'worker-1');
      h.statuses = [{ id, category }];
      const res = await addNote('task-1', 'human-1', 'note');
      expect(res, category).toEqual({ steered: false });
      expect(h.updates, category).toHaveLength(0);
      expect(h.dispatches, category).toHaveLength(0);
    }
  });

  it('a human assignee never dispatches — thread-only, no flip', async () => {
    seedTask('st-working', 'human-9');
    h.statuses = [{ id: 'st-working', category: CATEGORY.WORKING }];
    h.aiEmployees = [];
    const res = await addNote('task-1', 'human-1', 'note');
    expect(res).toEqual({ steered: false });
    expect(h.updates).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a dangling status id (no task_statuses row) refuses — dead input, never a dispatch guess', async () => {
    seedTask('st-legacy-dangling', 'worker-1');
    h.statuses = [];
    const res = await addNote('task-1', 'human-1', 'note');
    expect(res).toEqual({ steered: false });
    expect(h.updates).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
  });

  it('a steered live run returns before any status read or flip', async () => {
    seedTask('st-working', 'worker-1');
    h.statuses = [{ id: 'st-working', category: CATEGORY.WORKING }];
    h.steerState = 'steered';
    const res = await addNote('task-1', 'human-1', 'steer it');
    expect(res).toEqual({ steered: true });
    expect(h.updates).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
  });
});
