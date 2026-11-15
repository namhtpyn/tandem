// PROPOSAL DECISION EVENTS (#466): proposals' in-transaction notes (proposal rejected /
// subtask created / reassigned) defer their change events to the decision caller's
// post-commit publish (#397). The reject path must therefore publish BOTH resources
// after the transaction commits — dropping either silently leaves other clients' proposal
// panels and threads stale (the note row lands, no event announces it). This suite pins
// the reject pair end-to-end and the deferral hand-off itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  proposalRows: [] as Array<Record<string, unknown>>,
  claimRows: [] as Array<Record<string, unknown>>,
  activities: [] as Array<{ body: string; ex: string; publish: boolean | undefined }>,
  published: [] as string[],
  txDone: false,
  publishedBeforeCommit: 0,
  // #479: the gating restore hands its resume work back through the collector
  gatingCalls: [] as number[],
  resumedAt: [] as boolean[],
  failNote: false,
}));

vi.mock('../../server/db/index', async () => {
  const { taskProposals } = await import('../../server/db/schema');
  const tx = {
    __tx: true,
    query: {
      taskProposals: { findMany: async () => h.proposalRows },
      // confirmProposal loads the proposal's task row before executing its kind
      tasks: {
        findMany: async () => [{ id: 'task-1', ownerId: 'owner-1', createdBy: 'owner-1', assigneeId: 'agent-1' }],
      },
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        // the rollback pin (#479): fail the decision note — a throw AFTER the gating
        // call inside the transaction
        if (h.failNote && 'decisionNote' in values) throw new Error('decision note write failed');
        return { where: () => ({ returning: async () => (table === taskProposals ? h.claimRows : []) }) };
      },
    }),
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        const out = await fn(tx);
        h.txDone = true;
        return out;
      },
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    // proposals' logActivity -> review.service.logActivity -> insertActivityMessage; the
    // review-side module is mocked below, so this only matters for other callers
    insertActivityMessage: async () => {},
  };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    logActivity: async (
      _taskId: string,
      _kind: unknown,
      _authorId: string | null,
      body: string,
      _meta: Record<string, unknown>,
      ex: { __tx?: boolean } | undefined,
      opts: { publish?: boolean } | undefined,
    ) => {
      h.activities.push({ body, ex: ex?.__tx === true ? 'tx' : 'pool', publish: opts?.publish });
    },
  };
});

vi.mock('../../server/domains/tasks/gating.service', () => ({
  // #479: a riding gating restore never runs its resume work itself — it appends it to
  // the caller's collector, and the caller drains it post-commit
  refreshParentGating: async (_taskId: string, _ex: unknown, afterCommit?: Array<() => Promise<void>>) => {
    h.gatingCalls.push(afterCommit?.length ?? -1);
    afterCommit?.push(async () => {
      h.resumedAt.push(h.txDone);
    });
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string) => {
      // an event announced inside the transaction would be erased by a rollback (#397)
      if (!h.txDone) h.publishedBeforeCommit += 1;
      h.published.push(resource);
    },
  };
});

import { confirmProposal, rejectProposal } from '../../server/domains/tasks/proposals.service';

beforeEach(() => {
  h.proposalRows = [{ taskId: 'task-1', kind: 'SUBTASKS' }];
  h.claimRows = [{ id: 'proposal-1' }];
  h.activities = [];
  h.published = [];
  h.txDone = false;
  h.publishedBeforeCommit = 0;
});

describe('proposal decision events (#466)', () => {
  it('reject: the in-tx note defers and the decision publishes BOTH resources after commit', async () => {
    await rejectProposal('proposal-1', 'user-1', 'no thanks');
    // the note rides the transaction and defers its events (#397)
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]?.ex).toBe('tx');
    expect(h.activities[0]?.publish).toBe(false);
    expect(h.activities[0]?.body).toContain('proposal rejected');
    // the decision caller owns the post-commit set: activity + tasks
    expect(h.published.sort()).toEqual(['TASKS', 'TASK_ACTIVITY']);
    // ...and only AFTER the transaction committed (#397)
    expect(h.publishedBeforeCommit).toBe(0);
  });
});

// BORROWED-RESTORE DEFERRAL (#479): the riding gating refresh must hand its resume work
// back to confirmProposal through the collector, and confirmProposal must drain it only
// after db.transaction resolves. A rollback (any throw after the gating call) drops the
// collector on the floor — no settle, no dispatch outlives an erased restore row.
describe('borrowed-restore deferral wiring (#479)', () => {
  beforeEach(() => {
    h.proposalRows = [{ taskId: 'task-1', kind: 'SUBTASKS', status: 'PROPOSED', payload: { items: [] } }];
  });

  it('confirm: the riding restore resume drains only after the commit', async () => {
    await confirmProposal('proposal-1', 'user-1');
    expect(h.gatingCalls).toEqual([0]); // a fresh collector was handed down
    expect(h.resumedAt).toEqual([true]); // ran with txDone already true — post-commit
    expect(h.publishedBeforeCommit).toBe(0);
  });

  it('confirm: a rollback after the gating call discards the resume work', async () => {
    h.failNote = true;
    await expect(confirmProposal('proposal-1', 'user-1')).rejects.toThrow('decision note write failed');
    expect(h.gatingCalls).toEqual([0]);
    expect(h.resumedAt).toEqual([]); // never drained — no settle/dispatch outlives the rollback
  });
});
