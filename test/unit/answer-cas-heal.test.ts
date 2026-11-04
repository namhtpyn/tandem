// CAS-MISS HEAL on the answer path (#314): answerQuestion cancels the ANSWER
// obligation BEFORE the arbitration flip; a 0-row CAS miss (any concurrent task
// write won) used to throw while the cancellation stood — the task stayed
// waiting_answer with NO obligation, so the question dropped off every
// needs-my-decision surface with no heal (the retry gate checks chain
// membership, not obligation presence). The heal re-spawns the obligation when
// the task STILL reads the same waiting_answer status (PENDING-dedupe makes the
// restore idempotent); when the status MOVED, the rival writer owns the outcome
// (TERMINAL ARBITRATION #287/#292) — never a stale resurrection off the flow.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, OBLIGATION_ROLE } from '#shared/enums';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  healReadStatus: null as string | null,
  statuses: [] as Array<{ id: string; category: string }>,
  spawns: [] as Array<{ taskId: string; employeeId: string; role: string }>,
  cancelled: [] as string[],
  taskUpdateWins: false,
  holder: 'holder-1' as string | null,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: () => ({ where: async () => [] as unknown[] }),
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: () => ({
            returning: async () => (table === tasks && h.taskUpdateWins ? [{ id: 'task-1' }] : []),
          }),
        }),
      }),
      query: {
        tasks: {
          findMany: async () => h.taskRows,
          findFirst: async () => ({ status: h.healReadStatus }),
        },
        taskStatuses: { findMany: async () => h.statuses },
      },
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', () => ({
  openRoundLive: async () => false,
  dispatchAiReviewTurns: async () => {},
}));

vi.mock('../../server/domains/tasks/obligations.service', () => ({
  answerHolder: async () => h.holder,
  cancelObligations: async (_taskId: unknown, role: string) => {
    h.cancelled.push(String(role));
  },
  spawnObligation: async (taskId: string, employeeId: string, role: string) => {
    h.spawns.push({ taskId, employeeId, role });
    return 'obl-1';
  },
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async () => {},
  hasOpenChildren: async () => false,
}));

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async () => {} };
});

import { answerQuestion } from '../../server/domains/tasks/workflow.service';

function seedWaitingTask(chain: string[]) {
  h.taskRows = [
    {
      status: 'st-wait',
      assigneeId: 'worker-1',
      ownerId: 'holder-1',
      createdBy: 'holder-1',
      questionChain: chain,
      reviewers: [],
      updatedAt: new Date('2026-11-04T00:00:00Z'),
    },
  ];
  h.statuses = [{ id: 'st-wait', category: CATEGORY.WAITING_ANSWER }];
}

beforeEach(() => {
  h.spawns = [];
  h.cancelled = [];
  h.taskUpdateWins = false;
  h.healReadStatus = null;
  h.holder = 'holder-1';
  seedWaitingTask(['holder-1', 'answerer']);
});

describe('answerQuestion CAS-miss heal (#314)', () => {
  it('a lost flip while the task still waits restores the obligation, then refuses', async () => {
    h.healReadStatus = 'st-wait';
    await expect(answerQuestion('task-1', 'answerer', 'the answer')).rejects.toThrow(
      /task state changed during answer/,
    );
    expect(h.cancelled).toEqual([String(OBLIGATION_ROLE.ANSWER)]);
    expect(h.spawns).toEqual([{ taskId: 'task-1', employeeId: 'holder-1', role: String(OBLIGATION_ROLE.ANSWER) }]);
  });

  it('a lost flip after the status moved never resurrects a stale obligation', async () => {
    h.healReadStatus = 'st-custom-done';
    await expect(answerQuestion('task-1', 'answerer', 'the answer')).rejects.toThrow(
      /task state changed during answer/,
    );
    expect(h.spawns).toHaveLength(0);
  });

  it('a null holder falls back to the question-chain tail', async () => {
    seedWaitingTask(['holder-1', 'tail-guy']);
    // the author must be in the chain to pass the gate — 'tail-guy' is both
    h.holder = null;
    h.healReadStatus = 'st-wait';
    await expect(answerQuestion('task-1', 'tail-guy', 'the answer')).rejects.toThrow(
      /task state changed during answer/,
    );
    expect(h.spawns).toEqual([{ taskId: 'task-1', employeeId: 'tail-guy', role: String(OBLIGATION_ROLE.ANSWER) }]);
  });

  it('a WON flip (no race) takes the normal path — no heal spawn', async () => {
    h.taskUpdateWins = true;
    const res = await answerQuestion('task-1', 'answerer', 'the answer');
    expect(res).toEqual({ ok: true });
    expect(h.spawns).toHaveLength(0);
  });
});
