// HOLD-WINDOW REPAIR on the answer path (#288 r5): the verdict hold's revert can
// land between answerQuestion's openRoundLive read and its return flip — the
// answer believed the round dead and returned the task to todo, but the round is
// LIVE again (the held reviewer's row is PENDING once more). The answer then
// re-checks liveness post-flip and repairs: ONE guarded ready->in_review flip +
// the reviewer re-fire. No held round strands on a ready status.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OBLIGATION_ROLE, CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  roundReads: 0,
  roundLiveFirst: false,
  roundLiveSecond: false,
  taskUpdates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  lossyRepair: false,
  dispatched: [] as string[],
  cancelled: [] as string[],
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: (table: unknown) => {
          void table;
          const resolveRows = () => Promise.resolve([]); // employeeSupervisors reads: empty
          return {
            where: async () => resolveRows(),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              if (table !== tasks) return [];
              h.taskUpdates.push({ set, where: cond });
              // the answer's arbitration flip always wins; the repair flip wins
              // unless the test models it losing (h.lossyRepair)
              if (h.lossyRepair && h.taskUpdates.length === 2) return [];
              return [{ id: 'task-1' }];
            },
          }),
        }),
      }),
      query: {
        tasks: {
          findMany: async () => h.taskRows,
        },
        taskStatuses: {
          findMany: async () => h.statuses,
        },
      },
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', () => ({
  // call-sequenced: [0] = answerQuestion's backTo read, [1] = the post-flip re-check
  openRoundLive: async () => (h.roundReads++ === 0 ? h.roundLiveFirst : h.roundLiveSecond),
  // #365: no void pending row in these specs
  settleExtinguishedRound: async () => false,
  dispatchAiReviewTurns: async (taskId: string) => {
    h.dispatched.push(taskId);
  },
}));

vi.mock('../../server/domains/tasks/obligations.service', () => ({
  cancelObligations: async (_taskId: unknown, role: unknown) => {
    h.cancelled.push(String(role));
  },
  spawnObligation: async () => 'obl-1',
  resolveObligation: async () => {},
  answerHolder: async () => 'owner-1',
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async () => {},
  hasOpenChildren: async () => false,
}));

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
  return { ...mod, publishChange: async () => {} };
});

import { answerQuestion } from '../../server/domains/tasks/workflow.service';

const WAIT = STATUS.waitingAnswer ?? 'st-wait';
const BEFORE = () => {
  h.taskRows = [
    {
      status: WAIT,
      questionChain: ['holder-1'],
      updatedAt: new Date(0),
    },
  ];
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: WAIT, category: CATEGORY.WAITING_ANSWER },
  ];
  h.roundReads = 0;
  h.roundLiveFirst = false;
  h.roundLiveSecond = false;
  h.taskUpdates = [];
  h.lossyRepair = false;
  h.dispatched = [];
  h.cancelled = [];
  h.notes = [];
};

beforeEach(BEFORE);

describe('answerQuestion hold-window repair (#288 r5)', () => {
  it('a dead-round answer returns the task to todo exactly as before (no repair arm)', async () => {
    const res = await answerQuestion('task-1', 'holder-1', 'the answer');
    expect(res).toEqual({ ok: true });
    expect(h.taskUpdates).toHaveLength(1); // the return flip only
    expect(h.taskUpdates[0]!.set.status).toBe(STATUS.todo);
    expect(h.dispatched).toHaveLength(0);
    expect(h.notes).toHaveLength(1); // the answer note only
    expect(h.cancelled).toEqual([OBLIGATION_ROLE.ANSWER]);
  });

  it('the hold-revert raced the answer: the post-flip liveness re-check repairs to in_review + re-fires', async () => {
    // openRoundLive said DEAD when the answer read it (the hold's revert had not
    // landed) — but by the time the flip won, the held row is PENDING again
    h.roundLiveSecond = true;
    const res = await answerQuestion('task-1', 'holder-1', 'the answer');
    expect(res).toEqual({ ok: true });
    expect(h.taskUpdates).toHaveLength(2); // return flip (todo) + repair flip (in_review)
    expect(h.taskUpdates[1]!.set.status).toBe(STATUS.inReview);
    expect(h.taskUpdates[1]!.where).not.toBeNull(); // the repair is guarded (ready-category only)
    expect(h.dispatched).toEqual(['task-1']); // the held reviewer re-fires
    expect(h.notes.some((n) => n.payload.reviewResumed)).toBe(true); // the repair is on the thread
  });

  it('a repair flip lost to a yet-another move still notes the thread (never a silent strand)', async () => {
    h.roundLiveSecond = true;
    h.lossyRepair = true; // the dispatcher claimed the task to doing between the answer's flip and the repair
    const res = await answerQuestion('task-1', 'holder-1', 'the answer');
    expect(res).toEqual({ ok: true });
    expect(h.taskUpdates).toHaveLength(2); // return flip + attempted repair flip
    expect(h.dispatched).toHaveLength(0); // nothing re-fired — the task moved again
    expect(h.notes.some((n) => n.payload.reviewResumed)).toBe(true); // documented, never silent
  });
});
