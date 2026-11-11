// VERDICT-LESS CORRECTION threading (#276): the verdict-less settle path's bounded
// re-dispatch is the ONLY caller allowed to set verdictCorrection — the retry brief
// then carries the CORRECTION block; every first-turn/next-reviewer dispatch leaves
// it off (a first-turn brief must never carry the block).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatchCalls: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  runMarks: [] as Array<Record<string, unknown>>,
  aiIds: [] as string[],
}));

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts?: Record<string, unknown>) => {
      h.dispatchCalls.push(opts ?? {});
      return { runId: 'run-1' };
    },
  };
});

// Minimal drizzle-shaped chain: rows resolved by the projected columns —
// {round} = currentRound, {resultBody} = roundResultBody, {id} = live-run check
// (empty: nothing running), no columns = the pending reviewer-row read.
type Chain = {
  where: (c?: unknown) => Chain;
  orderBy: (o?: unknown) => Chain;
  limit: (n?: number) => Promise<unknown[]>;
  innerJoin: (t?: unknown, on?: unknown) => Chain;
  then: <T>(onfulfilled?: (value: unknown[]) => T) => Promise<T>;
};

const mkChain = (cols: unknown, isTaskRow = false): Chain => {
  const resolve = (): unknown[] => {
    const c = (cols ?? {}) as Record<string, unknown>;
    // the IN-REVIEW MINT GATE's task-status read (#401)
    if (isTaskRow && 'status' in c) return [{ status: 'st-review' }];
    if ('round' in c) return [{ round: 1 }];
    if ('resultBody' in c) return [{ resultBody: 'submitted work' }];
    if ('id' in c) return [];
    // the mint's settle-owned ordering read (#402 r5): reviewer → newest run mark
    if ('employeeId' in c) return h.runMarks;
    if (h.rows.length) return h.rows;
    return [{ reviewerId: 'rev-1', round: 1, status: 'PENDING', createdAt: new Date() }];
  };
  const ch: Chain = {
    where: () => ch,
    orderBy: () => ch,
    limit: async () => resolve(),
    innerJoin: () => ch,
    then: (onfulfilled) => Promise.resolve(resolve()).then((v) => (onfulfilled ? onfulfilled(v) : (v as never))),
  };
  return ch;
};

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols?: unknown) => ({ from: (table: unknown) => mkChain(cols, table === tasks) }),
      query: {
        aiEmployees: { findMany: async () => (h.aiIds.length ? h.aiIds : ['rev-1']).map((userId) => ({ userId })) },
        // the IN-REVIEW MINT GATE (#401) resolves the task's status category before
        // any dispatch; every case here mints on an in-review task
        taskStatuses: { findMany: async () => [{ id: 'st-review', category: 'in_review' }] },
      },
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return { ...mod, insertActivityMessage: async () => {} };
});

import { dispatchAiReviewTurns } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.dispatchCalls = [];
  h.rows = [];
  h.runMarks = [];
  h.aiIds = [];
});

describe('dispatchAiReviewTurns verdictCorrection threading (#276)', () => {
  it('carries verdictCorrection=true only for the verdict-less reviewer it re-dispatches', async () => {
    await dispatchAiReviewTurns('task-1', 'submitted work', {
      verdictCorrection: true,
      verdictlessReviewerId: 'rev-1',
    });
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.verdictCorrection).toBe(true);
    expect(h.dispatchCalls[0]?.reviewBy).toBe('rev-1');
  });

  it('a correction dispatch NEVER mints for a different pending reviewer (target-scoped)', async () => {
    // blind-review r5: the retry targets ONLY the verdict-less reviewer's row; if
    // that row is no longer pending, nothing mints — the round moved on. Row-order
    // ties must never hand the retry to another reviewer.
    await dispatchAiReviewTurns('task-1', 'submitted work', {
      verdictCorrection: true,
      verdictlessReviewerId: 'someone-else',
    });
    expect(h.dispatchCalls).toHaveLength(0);
  });

  it('first-turn / next-reviewer dispatches never carry the correction', async () => {
    await dispatchAiReviewTurns('task-1', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.verdictCorrection).toBe(false);
  });
});

describe('dispatchAiReviewTurns settle-owned ordering (#402 r5)', () => {
  const minted = new Date('2026-11-11T00:00:00Z');
  const row = (reviewerId: string, createdAt: Date) => ({ reviewerId, round: 1, status: 'PENDING', createdAt });

  it('mints the reviewer who never had a turn before one whose newest run is DONE', async () => {
    // A's turn reached DONE but its settle was lost — the settle-replay arm owns A. A mint
    // that picked A first would open a later run and mask the replay, so B goes first.
    h.rows = [row('rev-A', minted), row('rev-B', new Date(minted.getTime() + 1000))];
    h.runMarks = [{ employeeId: 'rev-A', status: 'DONE', startedAt: new Date(minted.getTime() + 500) }];
    h.aiIds = ['rev-A', 'rev-B'];
    await dispatchAiReviewTurns('task-1', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.reviewBy).toBe('rev-B');
  });

  it('the LAZY mint skips a settle-owned reviewer — no masking run (#402 r6)', async () => {
    // after another reviewer's verdict the settle owns A (its turn is DONE, its settle was
    // lost): minting A here would open a later run and hide the replay. The lazy mint
    // passes skipSettled, so nothing mints and the replay gets its window.
    h.rows = [row('rev-A', minted)];
    h.runMarks = [{ employeeId: 'rev-A', status: 'DONE', startedAt: new Date(minted.getTime() + 500) }];
    h.aiIds = ['rev-A'];
    await dispatchAiReviewTurns('task-1', 'submitted work', { skipSettled: true });
    expect(h.dispatchCalls).toHaveLength(0);
  });

  it('a RECOVERY caller keeps the fallback — a parked round never strands', async () => {
    // owner unblock-resume / removal re-fire mint without skipSettled: a reviewer whose
    // own turn is DONE (a parked verdict-less correction) must still get its turn
    h.rows = [row('rev-A', minted)];
    h.runMarks = [{ employeeId: 'rev-A', status: 'DONE', startedAt: new Date(minted.getTime() + 500) }];
    h.aiIds = ['rev-A'];
    await dispatchAiReviewTurns('task-1', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.reviewBy).toBe('rev-A');
  });

  it('a targeted mint ignores the ordering (the #397 sweep names its reviewer)', async () => {
    h.rows = [row('rev-A', minted), row('rev-B', new Date(minted.getTime() + 1000))];
    h.runMarks = [{ employeeId: 'rev-A', status: 'DONE', startedAt: new Date(minted.getTime() + 500) }];
    h.aiIds = ['rev-A', 'rev-B'];
    await dispatchAiReviewTurns('task-1', 'submitted work', { targetReviewerId: 'rev-A' });
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.reviewBy).toBe('rev-A');
  });
});
