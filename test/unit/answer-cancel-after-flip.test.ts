// OBLIGATION CANCEL-AFTER-FLIP on the answer path (#314): answerQuestion used to
// cancel the ANSWER obligation BEFORE the arbitration flip; a 0-row CAS miss (any
// concurrent task write won) threw while the cancellation stood — the task stayed
// waiting_answer with NO obligation, so the question dropped off every
// needs-my-decision surface with no heal. Reordered (r1 review): the cancel runs
// only after a WON flip — a lost race touches NO obligation rows (the winning
// writer owns status AND obligations; a miss-path heal was reviewed out: an
// unguarded read→spawn re-opens the strand via settle write-then-cancel and
// forward races — shared-state guard law).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, OBLIGATION_ROLE } from '#shared/enums';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  spawns: [] as Array<{ taskId: string; employeeId: string; role: string }>,
  cancelled: [] as string[],
  seq: [] as string[],
  taskUpdateWins: false,
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
            returning: async () => {
              if (table !== tasks) return [];
              h.seq.push('flip');
              return h.taskUpdateWins ? [{ id: 'task-1' }] : [];
            },
          }),
        }),
      }),
      query: {
        tasks: {
          findMany: async () => h.taskRows,
        },
        taskStatuses: { findMany: async () => h.statuses },
      },
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', () => ({
  openRoundLive: async () => false,
  // #365: the round here carries no void pending row — the settle is a no-op
  settleExtinguishedRound: async () => false,
  dispatchAiReviewTurns: async () => {},
}));

vi.mock('../../server/domains/tasks/obligations.service', () => ({
  answerHolder: async () => 'holder-1',
  cancelObligations: async (_taskId: unknown, role: string) => {
    h.seq.push('cancel');
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
  h.seq = [];
  h.taskUpdateWins = false;
  seedWaitingTask(['holder-1', 'answerer']);
});

describe('answerQuestion cancels the ANSWER obligation only after a won flip (#314)', () => {
  it('a lost flip touches NO obligation rows — the winning writer owns status and obligations', async () => {
    await expect(answerQuestion('task-1', 'answerer', 'the answer')).rejects.toThrow(
      /task state changed during answer/,
    );
    expect(h.cancelled).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
    expect(h.seq).toEqual(['flip']);
  });

  it('a WON flip cancels the obligation AFTER the flip — never before', async () => {
    h.taskUpdateWins = true;
    const res = await answerQuestion('task-1', 'answerer', 'the answer');
    expect(res).toEqual({ ok: true });
    expect(h.cancelled).toEqual([String(OBLIGATION_ROLE.ANSWER)]);
    expect(h.seq).toEqual(['flip', 'cancel']);
    expect(h.spawns).toHaveLength(0);
  });
});
