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
  // #479: the gating restore hands its resume work back through the queue
  gatingCalls: [] as number[],
  executors: [] as string[],
  resumedAt: [] as boolean[],
  resumedDone: false,
  publishedAfterResume: [] as boolean[],
  txRef: null as unknown,
  failNote: false,
  failResume: false,
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
  h.txRef = tx;
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
  // #479: proposals constructs the REAL AfterCommitQueue (own module, not mocked here);
  // only the gating refresh itself is stubbed, so drain's failure isolation is exercised
  // for real — a hand-written queue double would bless a drain that stops on a throw.
  // A riding gating restore never runs its resume work itself — it defers it on
  // the caller's queue, and the caller drains it post-commit. The executor is recorded:
  // handing the pool `db` instead of `tx` is the exact regression this suite must catch.
  refreshParentGating: async (_taskId: string, ex: unknown, queue?: { defer: (w: () => Promise<void>) => void }) => {
    h.executors.push(ex === h.txRef ? 'tx' : 'other');
    h.gatingCalls.push(queue ? 1 : 0);
    queue?.defer(async () => {
      // a real resume awaits I/O: the drain must be awaited, not fire-and-forget
      await Promise.resolve();
      h.resumedAt.push(h.txDone);
      if (h.failResume) throw new Error('resume boom');
      h.resumedDone = true;
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
      // ...and the caller's post-commit resume must have finished BEFORE its publish
      h.publishedAfterResume.push(h.resumedDone);
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
  h.gatingCalls = [];
  h.executors = [];
  h.resumedAt = [];
  h.resumedDone = false;
  h.publishedAfterResume = [];
  h.failNote = false;
  h.failResume = false;
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
    expect(h.gatingCalls).toEqual([1]); // a queue was handed down
    expect(h.executors).toEqual(['tx']); // ...on the CALLER's transaction, never the pool
    expect(h.resumedAt).toEqual([true]); // ran with txDone already true — post-commit
    expect(h.publishedBeforeCommit).toBe(0);
    // the drain is awaited: both publishes follow the finished resume (a fire-and-forget
    // drain would publish first and leave resumedDone false here)
    expect(h.publishedAfterResume).toEqual([true, true]);
  });

  it('confirm: a THROWING resume never suppresses the caller post-commit publish', async () => {
    h.failResume = true;
    await expect(confirmProposal('proposal-1', 'user-1')).resolves.toEqual({ ok: true, events: [] });
    expect(h.resumedAt).toEqual([true]);
    expect(h.resumedDone).toBe(false); // the closure threw...
    expect(h.publishedAfterResume).toEqual([false, false]); // ...but BOTH publishes still ran
    expect(h.published.sort()).toEqual(['TASKS', 'TASK_ACTIVITY']);
  });

  it('confirm: a rollback after the gating call discards the resume work', async () => {
    h.failNote = true;
    await expect(confirmProposal('proposal-1', 'user-1')).rejects.toThrow('decision note write failed');
    expect(h.gatingCalls).toEqual([1]);
    expect(h.resumedAt).toEqual([]); // never drained — no settle/dispatch outlives the rollback
    expect(h.resumedDone).toBe(false);
  });
});
