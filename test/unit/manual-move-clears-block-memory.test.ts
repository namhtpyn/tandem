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
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
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
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          if (table === tasks) h.sets.push(set);
          return { where: async () => undefined };
        },
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return { ...mod, runningRunIdForTask: async () => null };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return { ...mod, teardownOnManualMove: async () => {}, logActivity: async () => {} };
});

vi.mock('../../server/domains/tasks/review-resume', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review-resume')>();
  return { ...mod, resumeRoundAfterManualMove: async () => false };
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
});
