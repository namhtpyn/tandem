// VERDICT-LESS CORRECTION threading (#276): the verdict-less settle path's bounded
// re-dispatch is the ONLY caller allowed to set verdictCorrection — the retry brief
// then carries the CORRECTION block; every first-turn/next-reviewer dispatch leaves
// it off (a first-turn brief must never carry the block).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatchCalls: [] as Array<Record<string, unknown>>,
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

const mkChain = (cols: unknown): Chain => {
  const resolve = (): unknown[] => {
    const c = (cols ?? {}) as Record<string, unknown>;
    if ('round' in c) return [{ round: 1 }];
    if ('resultBody' in c) return [{ resultBody: 'submitted work' }];
    if ('id' in c) return [];
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

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    select: (cols?: unknown) => ({ from: (_table: unknown) => mkChain(cols) }),
    query: {
      aiEmployees: { findMany: async () => [{ userId: 'rev-1' }] },
    },
  },
}));

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

  it('a DIFFERENT pending reviewer picked by the loop gets a clean first-turn brief', async () => {
    // blind-review r1: the block binds to the verdict-less reviewer, not to
    // "whoever the sequential loop picks"
    await dispatchAiReviewTurns('task-1', 'submitted work', {
      verdictCorrection: true,
      verdictlessReviewerId: 'someone-else',
    });
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.verdictCorrection).toBe(false);
  });

  it('first-turn / next-reviewer dispatches never carry the correction', async () => {
    await dispatchAiReviewTurns('task-1', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(1);
    expect(h.dispatchCalls[0]?.verdictCorrection).toBe(false);
  });
});
