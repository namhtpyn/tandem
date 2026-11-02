// REDIS RECONNECT-SELF-HEAL LAW (#238): the long-lived queue connection must
// reconnect FOREVER with capped backoff — a retry count there terminally
// abandons the client after ~2s while the cached domain keeps serving it
// (dispatch bricked until restart, watchdogs green). Only the BOOT connectivity
// ping keeps a fail-fast no-retry strategy (#147). The domain also exposes a
// never-throwing ping() for the watchdog stamp.
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Strategy = (retries: number) => number | Error;
type SocketOpts = { connectTimeout?: number; reconnectStrategy?: Strategy };
type ClientOpts = { url: string; socket?: SocketOpts };
type FakeClient = {
  opts: ClientOpts;
  ready: boolean;
  ping: () => Promise<string>;
};

const h = vi.hoisted(() => ({
  created: [] as FakeClient[],
}));

vi.mock('redis', () => ({
  createClient: (opts: ClientOpts) => {
    const c = {
      opts,
      ready: false,
      on: () => c,
      async connect() {
        c.ready = true;
      },
      disconnect() {
        c.ready = false;
      },
      get isReady() {
        return c.ready;
      },
      async ping() {
        if (!c.ready) throw new Error('The client is closed');
        return 'PONG';
      },
    };
    h.created.push(c as unknown as FakeClient);
    return c;
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    async close() {}
    async add() {
      return { id: 'j1' };
    }
  },
  Worker: class {
    async close() {}
  },
  createNodeRedisClient: (raw: unknown) => raw,
}));

import { redisQueue } from '../../server/domains/kernel/queue';

beforeAll(async () => {
  // one domain for the whole file — the module caches domainPromise by design
  await redisQueue();
});

function workerClient(): FakeClient {
  const c = h.created.find((x) => x.opts.socket?.connectTimeout === 2000);
  expect(c, 'worker connection was created').toBeDefined();
  return c!;
}

function bootPingClient(): FakeClient {
  const c = h.created.find((x) => x.opts.socket?.connectTimeout === 15_000);
  expect(c, 'boot ping connection was created').toBeDefined();
  return c!;
}

describe('queue reconnect strategy (#238)', () => {
  it('the long-lived worker connection never terminally abandons — strategy returns a finite number at ANY retry count', () => {
    const strategy = workerClient().opts.socket!.reconnectStrategy!;
    for (const retries of [0, 1, 3, 4, 10, 1_000, 1_000_000]) {
      const delay = strategy(retries);
      expect(delay, `retries=${retries}`).toEqual(expect.any(Number));
      expect(delay, `retries=${retries}`).toBeLessThanOrEqual(1_000);
    }
  });

  it('the boot connectivity ping keeps its fail-fast no-retry strategy (#147)', () => {
    const strategy = bootPingClient().opts.socket!.reconnectStrategy!;
    expect(strategy(1)).toBeInstanceOf(Error);
  });
});

describe('QueueDomain.ping (watchdog leg, #238)', () => {
  it('reports true on a ready connection and false (never throws) when the client is down', async () => {
    const domain = await redisQueue();
    const raw = workerClient();
    await expect(domain.ping()).resolves.toBe(true);
    raw.ready = false;
    await expect(domain.ping()).resolves.toBe(false);
    raw.ready = true;
    await expect(domain.ping()).resolves.toBe(true);
  });

  it('a ping() error is swallowed into false, not propagated', async () => {
    const domain = await redisQueue();
    const raw = workerClient();
    const orig = raw.ping;
    raw.ping = async () => {
      throw new Error('timeout mid-flight');
    };
    await expect(domain.ping()).resolves.toBe(false);
    raw.ping = orig;
  });
});
