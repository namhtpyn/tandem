// SSE-AMPLIFICATION LAW (#253): streaming flushes append the new transcript
// slice to the run row at flush cadence, but RUNS change events publish at
// most once per publish heartbeat — the transcript payload must never ship
// per-flush to every live client. The builder-mock records appends, the kernel
// mock records publishes; real timers drive the cadence (no fake timers: the
// gate reads Date.now() at flush time).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHANGE_RESOURCE } from '#shared/enums';

const h = vi.hoisted(() => ({
  appends: 0,
  published: [] as Array<[string, string]>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: new Proxy(
        {},
        {
          get: () => ({ findMany: async () => [], findFirst: async () => null }),
        },
      ),
      update: (table: unknown) => ({
        set: (_set: Record<string, unknown>) => ({
          where: (_where: unknown) =>
            // a real promise: the writer chains .then/.catch/.finally on it
            Promise.resolve().then(() => {
              if (table === taskRuns) h.appends += 1;
            }),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string, action: string) => {
      h.published.push([resource, action]);
    },
  };
});

// parkRound is dynamically imported by the settle paths and statically by the
// service — the mock intercepts BOTH; its internal db chain never runs here
vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    parkRound: async () => {},
  };
});

import { setEnv } from '../../server/domains/kernel/env';
import { createRunWriter } from '../../server/domains/tasks/runner.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  setEnv({ TANDEM_RUN_FLUSH_MS: undefined, TANDEM_RUN_PUBLISH_MS: undefined });
});

describe('run writer publish cadence (#253)', () => {
  it('appends per flush but publishes at most one RUNS event per heartbeat window', async () => {
    setEnv({ TANDEM_RUN_FLUSH_MS: '20', TANDEM_RUN_PUBLISH_MS: '300' });
    h.appends = 0;
    h.published.length = 0;
    const writer = createRunWriter('run-cadence', '', 'msg-cadence');
    // ~1s of streaming output: one line every 20ms
    for (let i = 0; i < 50; i += 1) {
      writer.onLine(`line ${i}`);
      await sleep(20);
    }
    await sleep(60); // let the last flush chain settle
    const runsEvents = h.published.filter(([r]) => r === CHANGE_RESOURCE.RUNS);
    expect(h.appends).toBeGreaterThanOrEqual(10); // DB append rode the flush cadence
    expect(runsEvents.length).toBeLessThanOrEqual(5); // ≤ 1 per 300ms window (+ timer jitter)
    expect(runsEvents.length).toBeLessThan(h.appends); // transcript never ships per-flush
  });
});
