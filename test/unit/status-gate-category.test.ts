// CATEGORY-GATE LAW (#336, sibling of #265): every lifecycle GATE resolves the
// task's status CATEGORY against task_statuses — the seeded uuids are landing /
// write targets only. Before this law the human verdicts, escalate, park, the
// ask gate and the proposal terminal check compared task.status to seeded ids:
// a task moved to a custom status in the SAME category (status freedom, Statuses
// manager) was a UI-offered, server-refused dead end — the review box renders by
// category while every verdict 400'd 'task is not in review', and a park silently
// missed, wedging the round with a PENDING row and no run.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, PROPOSAL_KIND } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  flips: [] as Array<{ set: Record<string, unknown> }>,
  inserts: [] as Array<Record<string, unknown>>,
  verdicts: [] as Array<{ verdict: unknown }>,
  teardowns: [] as string[],
  cancelled: [] as string[],
  spawned: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        // the only table-select consumer on these paths is recordProposals' task read
        from: (table: unknown) => ({
          where: () => ({
            then: (onF?: (v: Array<Record<string, unknown>>) => unknown) =>
              Promise.resolve(table === tasks ? h.taskRows : ([] as Array<Record<string, unknown>>)).then(onF),
            orderBy: () => ({
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) =>
                Promise.resolve(table === tasks ? h.taskRows : ([] as Array<Record<string, unknown>>)).then(onF),
            }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            const applied = () => {
              h.flips.push({ set });
              return table === tasks ? [{ id: 'task-1' }] : [];
            };
            return {
              returning: async () => applied(),
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
              catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
            };
          },
        }),
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          h.inserts.push(v);
        },
      }),
      query: {
        tasks: { findMany: async () => h.taskRows },
        taskStatuses: {
          // honor the caller's predicate (DB-mock predicate law): a mis-wired where
          // must FAIL the test, never be masked by an unfiltered mock
          findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
            const id = args?.where?.id?.eq;
            return id ? h.statuses.filter((s) => s.id === id) : h.statuses;
          },
        },
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
    cancelObligations: async (_t: unknown, role: unknown) => void h.cancelled.push(String(role)),
    spawnObligation: async (_t: unknown, holder: string) => void h.spawned.push(String(holder)),
    resolveObligation: async () => {},
    answerHolder: async () => null,
    cancelAllObligations: async () => {},
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {}, hasOpenChildren: async () => false };
});

// FULL stub (never importOriginal): the real module's runner.service import cycles
// back into workflow.service, and an original-load caches the REAL review bindings
// ahead of this test's mocks. The stub is the whole exported surface the other
// services touch.
vi.mock('../../server/domains/tasks/review.service', () => ({
  logActivity: async () => {},
  currentRound: async () => 1,
  dedupeReviewers: (r: string[]) => r,
  dispatchedReviewRoundRow: async () => null,
  dispatchedReviewRound: async () => 0,
  openReviewRound: async () => ({ round: 1, opened: 1, dropped: [] }),
  openRoundLive: async () => false,
  dispatchAiReviewTurns: async () => {},
  recordVerdict: async (_t: string, _r: string, verdict: unknown) => void h.verdicts.push({ verdict }),
  listReviews: async () => [],
  parseEscalationNote: () => ({ targetName: null, why: '' }),
  escalateReview: async () => ({ outcome: 'parked' as const }),
  PARK_REARM_LADDER_MS: [300_000, 1_800_000, 7_200_000, 21_600_000],
  parkRound: async () => true,
  teardownOnManualMove: async () => {},
  teardownOpenRound: async (_t: string, to: string) => void h.teardowns.push(to),
  verdictsSoFarFor: async () => [],
}));

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async () => {} };
});

import { recordProposals } from '../../server/domains/tasks/proposals.service';
import { abandonTask, approveReview, askQuestion, requestChanges } from '../../server/domains/tasks/workflow.service';

function seedTask(statusId: string) {
  h.taskRows = [
    {
      status: statusId,
      assigneeId: 'worker-1',
      ownerId: 'owner-1',
      createdBy: 'owner-1',
      questionChain: [],
      reviewers: ['rev-1'],
    },
  ];
}

beforeEach(() => {
  h.taskRows.length = 0;
  h.statuses.length = 0;
  h.flips = [];
  h.inserts = [];
  h.verdicts = [];
  h.teardowns = [];
  h.cancelled = [];
  h.spawned = [];
});

describe('ask gate keys off the working / in-review CATEGORY (#336)', () => {
  it('a custom WORKING-category status asks — the task parks on waiting-answer', async () => {
    seedTask('st-custom-doing');
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    await askQuestion('task-1', 'worker-1', 'which scope?');
    expect(h.spawned).toEqual(['owner-1']);
    expect(h.flips[0]?.set.status).toBe(STATUS.waitingAnswer);
  });

  it('a custom IN-REVIEW-category status asks — a review turn may stall on a question', async () => {
    seedTask('st-custom-review');
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    await askQuestion('task-1', 'worker-1', 'which acceptance bar?');
    expect(h.flips[0]?.set.status).toBe(STATUS.waitingAnswer);
  });

  it('a TERMINAL category refuses — dead end closed, not widened', async () => {
    seedTask('st-custom-done');
    h.statuses = [{ id: 'st-custom-done', category: CATEGORY.DONE }];
    await expect(askQuestion('task-1', 'worker-1', 'late?')).rejects.toThrow(/in progress or review/);
    expect(h.flips).toHaveLength(0);
  });

  it('a dangling status id refuses — dead input, never a guess', async () => {
    seedTask('st-legacy-dangling');
    h.statuses = [];
    await expect(askQuestion('task-1', 'worker-1', 'late?')).rejects.toThrow(/in progress or review/);
  });
});

describe('human verdicts key off the in-review CATEGORY (#336)', () => {
  it('approve on a custom in-review status records the verdict', async () => {
    seedTask('st-custom-review');
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    await approveReview('task-1', 'rev-1', 'looks good');
    expect(h.verdicts).toHaveLength(1);
  });

  it('requestChanges on a custom in-review status records the verdict', async () => {
    seedTask('st-custom-review');
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    await requestChanges('task-1', 'rev-1', 'tighten the copy');
    expect(h.verdicts).toHaveLength(1);
  });

  it('a verdict on a non-review category still refuses', async () => {
    seedTask('st-custom-doing');
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    await expect(approveReview('task-1', 'rev-1', 'nope')).rejects.toThrow(/not in review/);
    expect(h.verdicts).toHaveLength(0);
  });
});

describe('abandon branches on the CATEGORY (#336)', () => {
  it('a custom in-review status abandons through the round-teardown path', async () => {
    seedTask('st-custom-review');
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    await abandonTask('task-1', 'rev-1', 'call it off');
    expect(h.teardowns).toEqual(['cancelled']);
    expect(h.cancelled).toContain('APPROVAL');
    expect(h.flips.at(-1)?.set.status).toBe(STATUS.cancelled);
  });
});

describe('proposal terminal check keys off the CATEGORY (#336)', () => {
  it('a run settling on a custom TERMINAL status records nothing', async () => {
    seedTask('st-custom-cancelled');
    h.statuses = [{ id: 'st-custom-cancelled', category: CATEGORY.CANCELLED }];
    await recordProposals('task-1', 'run-1', 'worker-1', [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Someone', reason: 'late' },
    ]);
    expect(h.inserts).toHaveLength(0);
  });

  it('a run settling on a live custom status still records the proposal', async () => {
    seedTask('st-custom-doing');
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    await recordProposals('task-1', 'run-1', 'worker-1', [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Someone', reason: 'handoff' },
    ]);
    expect(h.inserts).toHaveLength(1);
  });
});
