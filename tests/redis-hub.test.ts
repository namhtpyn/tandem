// Redis hub integration tests — real redis on 127.0.0.1:6399 (docker redis-spike), skipped when unreachable.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const REDIS_URL = 'redis://127.0.0.1:6399';

async function redisUp() {
  try {
    const { createClient } = await import('redis');
    const r = createClient({ url: REDIS_URL, socket: { connectTimeout: 500, reconnectStrategy: () => new Error('no-retry') } });
    r.on('error', () => {});
    await r.connect();
    await r.disconnect();
    return true;
  } catch {
    return false;
  }
}

const up = await redisUp();

describe.skipIf(!up)('redis hub (integration)', () => {
  beforeAll(() => {
    process.env.REDIS_URL = REDIS_URL;
  });

  it('enqueues and processes a job through the queue', async () => {
    const { redisQueue } = await import('../server/domains/kernel/queue');
    const hub = await redisQueue();
    expect(hub).toBeTruthy();
    const got: number[] = [];
    let resolveDone: () => void = () => {};
    const finished = new Promise<void>((r) => {
      resolveDone = r;
    });
    await hub!.queue<{ n: number }>('itest', async (d) => {
      got.push(d.n);
      resolveDone();
    });
    await hub!.enqueue('itest', { n: 42 });
    await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    expect(got).toContain(42);
  });

  it('cache set/get round-trips with TTL (cache domain)', async () => {
    const { appCache } = await import('../server/domains/kernel/cache');
    const cache = await appCache();
    await cache.set('itest-k', 'v', 30);
    expect(await cache.get('itest-k')).toBe('v');
    expect(await cache.get<string>('itest-miss')).toBeUndefined();
  });

  it('change encoding round-trips', async () => {
    const { encodeChange, decodeChange } = await import('../server/domains/kernel/change-bus');
    const e = { id: '1', resource: 'tasks' as const, action: 'update' as const, at: '2026-10-13T00:00:00Z' };
    expect(decodeChange(encodeChange(e))).toEqual(e);
  });

  afterAll(async () => {
    const { redisQueue } = await import('../server/domains/kernel/queue');
    const hub = await redisQueue();
    await hub?.close();
    delete process.env.REDIS_URL;
  });
});
