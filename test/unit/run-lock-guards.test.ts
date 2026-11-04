// RUN LOCK server-half guards (#264, r1 blind-review findings): the assignee
// surface had two unguarded writers — statuses.assign (auto-assign) and
// confirmProposal's reassign arm. SPEC: while a run is live, assignee edits are
// "rejected server-side" — pinned here for the confirm flow (the transaction
// rolls back, the proposal stays PROPOSED for a post-settle re-confirm) and the
// live-run check both paths consult.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { employeeSupervisors } from '../../server/db/schema';

const h = vi.hoisted(() => ({
  proposals: [] as Array<Record<string, unknown>>,
  taskRows: [] as Array<Record<string, unknown>>,
  liveRun: null as string | null,
  claimed: true,
  assigns: [] as Array<{ taskId: string; employeeId: string; reason: string }>,
  published: 0,
}));

const tx = {
  query: {
    taskProposals: { findMany: async () => h.proposals },
    tasks: { findMany: async () => h.taskRows },
    user: { findFirst: async () => ({ id: 'target-1', name: 'Target One' }) },
  },
  // findByName rides the select builder over the tx executor; supervisionChain
  // queries the supervisors table through the same builder — distinguish by the
  // FROM table (the chain must come back EMPTY or the escalate arm dead-ends)
  select: () => {
    const chain = {
      table: null as unknown,
      from(t: unknown) {
        this.table = t;
        return chain;
      },
      where: () => {
        const supervisors = chain.table === employeeSupervisors;
        const rows: Array<Record<string, unknown>> = supervisors ? [] : [{ id: 'target-1', name: 'Target One' }];
        const p = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & { orderBy?: () => unknown };
        p.orderBy = () => p;
        return p as never;
      },
    };
    return chain as never;
  },
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => (h.claimed ? [{ id: 'p-1' }] : []),
      }),
    }),
  }),
};

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    query: {},
    select: () => {
      throw new Error('unexpected select in confirm flow');
    },
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => void h.published++ };
});

vi.mock('../../server/domains/tasks/assignments.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/assignments.service')>();
  return {
    ...mod,
    assignTask: async (taskId: string, employeeId: string, reason: string) => {
      h.assigns.push({ taskId, employeeId, reason });
    },
    recentAssignees: async () => [],
    recordAssignment: async () => {},
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {} };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return { ...mod, logActivity: async () => {} };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return { ...mod, runningRunIdForTask: async () => h.liveRun };
});

import { confirmProposal } from '../../server/domains/tasks/proposals.service';

function seedReassign() {
  h.proposals = [
    {
      taskId: 'task-1',
      kind: 'REASSIGN',
      payload: { targetName: 'Target One', reason: 'spread the load' },
      status: 'PROPOSED',
    },
  ];
  h.taskRows = [{ id: 'task-1', ownerId: 'owner-1', createdBy: 'owner-1', assigneeId: 'worker-1' }];
  h.claimed = true;
}

beforeEach(() => {
  h.liveRun = null;
  h.assigns = [];
  h.published = 0;
  seedReassign();
});

describe('RUN LOCK guards on the assignee surface (#264 r1)', () => {
  it('confirming a reassign over a live run refuses — the proposal stays PROPOSED', async () => {
    h.liveRun = 'run-live';
    await expect(confirmProposal('p-1', 'owner-1')).rejects.toThrow(/waits until the run settles/);
    expect(h.assigns).toHaveLength(0);
  });

  it('a settled run confirms normally through the ledger writer', async () => {
    const res = await confirmProposal('p-1', 'owner-1');
    expect(res.ok).toBe(true);
    expect(h.assigns).toEqual([{ taskId: 'task-1', employeeId: 'target-1', reason: 'reassign: spread the load' }]);
  });
});
