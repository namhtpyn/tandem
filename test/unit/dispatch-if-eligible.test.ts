// #406: a null dispatch is a stale duplicate (the scan won the claim, the plan's
// assignee left the row, or the employee vanished) — the note's success copy follows
// this boolean, so it must report thread-only instead of claiming 'agent dispatched'.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ runId: null as string | null, calls: 0 }));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskStatuses: { findMany: async () => [{ id: 's-ready', category: 'ready' }] },
      // no assignee → the cap read is skipped; dispatch_after clear → eligible
      tasks: { findFirst: async () => ({ status: 's-ready', dispatchAfter: null, assigneeId: null }) },
    },
  },
}));

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async () => {
      h.calls += 1;
      return { runId: h.runId };
    },
  };
});

import { dispatchIfEligible } from '../../server/domains/tasks/dispatcher.service';

beforeEach(() => {
  h.runId = null;
  h.calls = 0;
});

describe('dispatchIfEligible reports what actually fired (#406)', () => {
  it('a null run (lost claim / stale plan) returns false — the note stays thread-only', async () => {
    await expect(dispatchIfEligible('t-1', 'http://tandem.internal')).resolves.toBe(false);
    expect(h.calls).toBe(1);
  });

  it('a real run returns true — the note reports the dispatch', async () => {
    h.runId = 'run-1';
    await expect(dispatchIfEligible('t-1', 'http://tandem.internal')).resolves.toBe(true);
    expect(h.calls).toBe(1);
  });
});
