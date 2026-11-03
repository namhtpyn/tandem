// REDIS-BLIP BOOT LAW (#289): the boot change-fanout bridge retries a bounded
// number of attempts, then logs loudly and CONTINUES — a redis blip at restart
// must never abort boot (admin seed never runs) nor kill the process
// (crash-loop), and a replica must never come up silently with no fanout.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: 0,
  failFirst: 0,
  warns: [] as string[],
  errors: [] as string[],
}));

vi.mock('#server/domains/kernel/pubsub', () => ({
  redisPubsub: async () => {
    h.calls += 1;
    if (h.calls <= h.failFirst) throw new Error(`redis blip ${h.calls}`);
    return { subscribe: async (_channel: string, _cb: (m: string) => void) => {} };
  },
}));

import { bridgeRedisChangesWithRetry } from '#server/domains/kernel/change-bus';

beforeEach(() => {
  h.calls = 0;
  h.failFirst = 0;
  h.warns = [];
  h.errors = [];
});

const sink = () => ({
  warn: (m: string) => h.warns.push(m),
  error: (m: string) => h.errors.push(m),
});

describe('boot change-fanout bridge retry (#289)', () => {
  it('a healthy redis bridges on the first attempt', async () => {
    const up = await bridgeRedisChangesWithRetry({ delayMs: 1, log: sink() });
    expect(up).toBe(true);
    expect(h.calls).toBe(1);
    expect(h.warns).toHaveLength(0);
  });

  it('a redis blip at restart retries and recovers — boot completes, every retry logged', async () => {
    h.failFirst = 3;
    const up = await bridgeRedisChangesWithRetry({ attempts: 5, delayMs: 1, log: sink() });
    expect(up).toBe(true); // boot continues with the bridge UP
    expect(h.calls).toBe(4); // 3 failed + 1 recovered
    expect(h.warns).toHaveLength(3);
    expect(h.warns[0]).toContain('attempt 1/5');
    expect(h.errors).toHaveLength(0);
  });

  it('exhausted attempts log loudly and CONTINUE (resolve false) — never abort, never hang', async () => {
    h.failFirst = 99;
    const up = await bridgeRedisChangesWithRetry({ attempts: 3, delayMs: 1, log: sink() });
    expect(up).toBe(false); // degraded fanout, but boot completes
    expect(h.calls).toBe(3); // bounded — never an infinite retry
    expect(h.warns).toHaveLength(2);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('DEGRADED cross-replica fanout');
    expect(h.errors[0]).toContain('redis blip 3'); // the failure reason rides the log line
  });

  it('attempts is floored at 1 (a bad config can never skip the try entirely)', async () => {
    h.failFirst = 5;
    const up = await bridgeRedisChangesWithRetry({ attempts: 0, delayMs: 1, log: sink() });
    expect(up).toBe(false);
    expect(h.calls).toBe(1);
    expect(h.errors).toHaveLength(1);
  });
});
