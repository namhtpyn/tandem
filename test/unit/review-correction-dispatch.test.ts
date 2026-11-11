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
  round: 1,
  aiReads: 0,
  gate: null as Promise<void> | null,
  failNextDispatch: false,
}));

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts?: Record<string, unknown>) => {
      h.dispatchCalls.push(opts ?? {});
      if (h.failNextDispatch) {
        h.failNextDispatch = false;
        throw new Error('dispatch exploded');
      }
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
    if ('round' in c) return [{ round: h.round }];
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
        aiEmployees: {
          findMany: async () => {
            h.aiReads += 1;
            // test seam: suspend an in-flight mint INSIDE its critical section so a
            // racing caller provably loses the per-task lock
            if (h.gate) await h.gate;
            return (h.aiIds.length ? h.aiIds : ['rev-1']).map((userId: string) => ({ userId }));
          },
        },
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
  h.round = 1;
  h.aiReads = 0;
  h.gate = null;
  h.failNextDispatch = false;
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

describe('dispatchAiReviewTurns carried correction across the mint lock (#380)', () => {
  const minted = new Date('2026-11-11T00:00:00Z');
  const row = (reviewerId: string, createdAt: Date) => ({ reviewerId, round: 1, status: 'PENDING', createdAt });
  const correction = (taskId: string, reviewerId: string, round = 1) =>
    dispatchAiReviewTurns(taskId, undefined, { verdictCorrection: true, verdictlessReviewerId: reviewerId, round });
  const gateMint = () => {
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => (release = resolve));
    return release;
  };

  it('a correction queued behind an in-flight plain mint is CARRIED by it — one turn, corrected', async () => {
    // The #380 window: a plain mint holds the per-task lock, a verdict-less settle's
    // correction caller loses it. Without the carry that plain turn burns the ONE bounded
    // retry (#276) and the round parks with no corrected brief ever sent.
    h.rows = [row('rev-1', minted)];
    h.aiIds = ['rev-1'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-carry', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1)); // the plain mint is inside its critical section
    expect(await correction('task-carry', 'rev-1')).toBe(false); // the loser never dispatches
    expect(h.dispatchCalls).toHaveLength(0);
    release();
    expect(await plain).toBe(true);
    expect(h.dispatchCalls).toHaveLength(1); // exactly one turn
    expect(h.dispatchCalls[0]).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });

  it('never rides another reviewer — it waits for its own row and is consumed exactly once', async () => {
    h.rows = [row('rev-A', minted), row('rev-B', new Date(minted.getTime() + 1000))];
    h.aiIds = ['rev-A', 'rev-B'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-other', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    await correction('task-other', 'rev-B');
    release();
    await plain;
    expect(h.dispatchCalls).toHaveLength(1);
    // rev-A's turn is a plain first turn: the correction is bound to rev-B's row
    expect(h.dispatchCalls[0]).toMatchObject({ reviewBy: 'rev-A', verdictCorrection: false });
    // rev-B's own next mint carries it…
    h.rows = [row('rev-B', new Date(minted.getTime() + 1000))];
    await dispatchAiReviewTurns('task-other', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(2);
    expect(h.dispatchCalls[1]).toMatchObject({ reviewBy: 'rev-B', verdictCorrection: true });
    // …and only once: the parked intent is consumed by the dispatch that carried it
    await dispatchAiReviewTurns('task-other', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(3);
    expect(h.dispatchCalls[2]?.verdictCorrection).toBe(false);
  });

  it("two reviewers' parked corrections never overwrite each other", async () => {
    h.rows = [row('rev-A', minted), row('rev-B', new Date(minted.getTime() + 1000))];
    h.aiIds = ['rev-A', 'rev-B'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-two', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    await correction('task-two', 'rev-A');
    await correction('task-two', 'rev-B');
    release();
    await plain;
    expect(h.dispatchCalls[0]).toMatchObject({ reviewBy: 'rev-A', verdictCorrection: true });
    h.rows = [row('rev-B', new Date(minted.getTime() + 1000))];
    await dispatchAiReviewTurns('task-two', 'submitted work');
    expect(h.dispatchCalls[1]).toMatchObject({ reviewBy: 'rev-B', verdictCorrection: true });
  });

  it('is dropped when the round moves on — never a new round first-turn brief', async () => {
    h.rows = [row('rev-A', minted), row('rev-B', new Date(minted.getTime() + 1000))];
    h.aiIds = ['rev-A', 'rev-B'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-round', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    await correction('task-round', 'rev-B');
    release();
    await plain; // rev-A's plain turn lands; rev-B's correction stays parked
    expect(h.dispatchCalls[0]).toMatchObject({ reviewBy: 'rev-A', verdictCorrection: false });
    // the round moves on before rev-B is ever minted: its new-round turn is a FIRST turn
    h.round = 2;
    h.rows = [row('rev-B', new Date(minted.getTime() + 1000))];
    await dispatchAiReviewTurns('task-round', 'submitted work');
    expect(h.dispatchCalls[1]).toMatchObject({ reviewBy: 'rev-B', verdictCorrection: false });
  });

  it('a plain caller that loses the lock parks no intent', async () => {
    h.rows = [row('rev-1', minted)];
    h.aiIds = ['rev-1'];
    const release = gateMint();
    const first = dispatchAiReviewTurns('task-plain', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    expect(await dispatchAiReviewTurns('task-plain', 'submitted work')).toBe(false);
    release();
    await first;
    await dispatchAiReviewTurns('task-plain', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(2);
    expect(h.dispatchCalls.every((c: Record<string, unknown>) => c.verdictCorrection === false)).toBe(true);
  });

  it('a correction without the settle round parks nothing (the round is never guessed)', async () => {
    h.rows = [row('rev-1', minted)];
    h.aiIds = ['rev-1'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-noround', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    expect(
      await dispatchAiReviewTurns('task-noround', undefined, {
        verdictCorrection: true,
        verdictlessReviewerId: 'rev-1',
      }),
    ).toBe(false);
    release();
    await plain;
    await dispatchAiReviewTurns('task-noround', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(2);
    expect(h.dispatchCalls[1]?.verdictCorrection).toBe(false);
  });

  it("the correction's OWN mint failing parks its intent for the restore re-fire", async () => {
    // no lock contention: the correction caller wins the lock, its dispatch throws, the mint
    // parks the round — the restore must re-fire WITH the block, not a plain retry
    h.rows = [row('rev-1', minted)];
    h.aiIds = ['rev-1'];
    h.failNextDispatch = true;
    await expect(correction('task-ownfail', 'rev-1')).rejects.toBeTruthy(); // park path has no db here
    await dispatchAiReviewTurns('task-ownfail', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(2);
    expect(h.dispatchCalls[1]).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
  });

  it('a failed carried mint leaves the intent parked for the re-fire (consumed only after dispatch)', async () => {
    h.rows = [row('rev-1', minted)];
    h.aiIds = ['rev-1'];
    const release = gateMint();
    const plain = dispatchAiReviewTurns('task-fail', 'submitted work');
    await vi.waitFor(() => expect(h.aiReads).toBe(1));
    await correction('task-fail', 'rev-1');
    h.failNextDispatch = true;
    release();
    await expect(plain).rejects.toBeTruthy(); // the mint's park path has no db in this harness
    // the retry was never burned: the restore's re-mint still carries the correction
    await dispatchAiReviewTurns('task-fail', 'submitted work');
    expect(h.dispatchCalls).toHaveLength(2);
    expect(h.dispatchCalls[1]).toMatchObject({ reviewBy: 'rev-1', verdictCorrection: true });
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
