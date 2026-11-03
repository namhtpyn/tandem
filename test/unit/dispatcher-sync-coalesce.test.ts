// WORKER-SYNC COALESCING (#290): syncDispatchWorkers is check-then-act across an
// await and runs from four entry points — overlapping calls both saw "no worker"
// and both minted one (2×cap execution, no later sync removes the duplicate).
// Concurrent invocations coalesce onto ONE in-flight promise per process; the
// roster re-check stays authoritative once it lands.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  roster: [] as Array<{ userId: string }>,
  created: [] as string[],
  closed: [] as string[],
  gated: false,
  waiters: [] as Array<() => void>,
  cap: 1,
}));

vi.mock('#server/domains/kernel/queue', () => ({ redisQueue: async () => ({}) }));

vi.mock('#server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: vi.fn(async () => 30 * 60_000),
  getTasksPerAgent: vi.fn(async () => h.cap),
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      aiEmployees: {
        findMany: async () => h.roster,
      },
    },
  },
}));

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({ warn: () => {}, error: () => {}, success: () => {}, info: () => {}, start: () => {} }),
  },
}));

import { syncDispatchWorkers } from '#server/domains/tasks/dispatcher.service';

/** hub whose queue creation can be held open (the await window the old
 * check-then-act raced across) */
function hub() {
  return {
    queue: async (name: string) => {
      h.created.push(name);
      if (h.gated) await new Promise<void>((r) => h.waiters.push(r));
      return {
        close: async () => {
          h.closed.push(name);
        },
      };
    },
  };
}

const releaseAll = () => {
  h.gated = false; // later sequential queue calls (agent loop) run straight through
  for (const r of h.waiters.splice(0)) r();
};

beforeEach(() => {
  h.roster = [];
  h.created = [];
  h.closed = [];
  h.gated = false;
  h.waiters = [];
  h.cap = 1;
});

describe('syncDispatchWorkers coalescing (#290)', () => {
  it('two concurrent syncs create exactly ONE worker per agent (creation fn called once)', async () => {
    h.roster = [{ userId: 'a-290' }, { userId: 'b-290' }];
    h.gated = true; // hold every creation open — the exact race window
    const p1 = syncDispatchWorkers(hub());
    for (let i = 0; i < 200 && h.created.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const p2 = syncDispatchWorkers(hub()); // overlaps: same in-flight execution
    expect(p2).toBe(p1); // concurrent callers await the SAME promise
    releaseAll();
    await Promise.all([p1, p2]);
    expect(h.created.sort()).toEqual(['tandem-dispatch-a-290', 'tandem-dispatch-b-290']); // one per agent
  });

  it('a sync landing after the in-flight one re-checks the roster — no duplicate minting', async () => {
    h.roster = [{ userId: 'c-290' }];
    await syncDispatchWorkers(hub());
    await syncDispatchWorkers(hub()); // sequential re-sync: roster check stays authoritative
    await syncDispatchWorkers(hub());
    expect(h.created.filter((n) => n === 'tandem-dispatch-c-290')).toHaveLength(1); // minted once
    expect(h.closed.filter((n) => n === 'tandem-dispatch-c-290')).toHaveLength(0); // and never churned
  });

  it('a roster change after landing still resyncs (removed agent closed, survivor kept)', async () => {
    h.roster = [{ userId: 'd-290' }, { userId: 'e-290' }];
    await syncDispatchWorkers(hub());
    h.roster = [{ userId: 'd-290' }]; // e left the roster
    await syncDispatchWorkers(hub());
    expect(h.closed.filter((n) => n === 'tandem-dispatch-e-290')).toHaveLength(1); // e closed exactly once
    expect(h.created.filter((n) => n === 'tandem-dispatch-d-290')).toHaveLength(1); // d never re-minted
    expect(h.closed.filter((n) => n === 'tandem-dispatch-d-290')).toHaveLength(0);
  });

  it('a resync-intent caller colliding with an in-flight sync chains ONE follow-up — the new cap applies immediately', async () => {
    h.roster = [{ userId: 'f-290' }];
    h.gated = true;
    const p1 = syncDispatchWorkers(hub()); // in-flight, already read cap=1
    for (let i = 0; i < 200 && h.created.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    h.cap = 3; // the settings write lands UNDER the in-flight sync
    const p2 = syncDispatchWorkers(hub(), { resyncAfter: true });
    expect(p2).not.toBe(p1); // chained — a fresh execution must follow, not the stale one
    releaseAll();
    await Promise.all([p1, p2]);
    // the follow-up re-minted at the new cap (close + recreate), immediately
    expect(h.created.filter((n) => n === 'tandem-dispatch-f-290')).toHaveLength(2);
    expect(h.closed.filter((n) => n === 'tandem-dispatch-f-290')).toHaveLength(1);
  });

  it('a plain concurrent caller (no resync intent) still coalesces onto the in-flight sync', async () => {
    h.roster = [{ userId: 'g-290' }];
    h.gated = true;
    const p1 = syncDispatchWorkers(hub());
    for (let i = 0; i < 200 && h.created.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    h.cap = 4;
    const p2 = syncDispatchWorkers(hub()); // no resyncAfter: shares the in-flight read
    expect(p2).toBe(p1);
    releaseAll();
    await Promise.all([p1, p2]);
    expect(h.created).toEqual(['tandem-dispatch-g-290']); // single execution
  });
});
