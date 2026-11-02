// REDIS-OK STAMP (#238): the tick stamps `dispatcher_redis_ok` ONLY when the
// queue domain pings healthy — during an outage the stamp goes stale while the
// heartbeat keeps writing, which is exactly the probe's brick signature
// (heartbeat fresh + redis stamp stale). Same 30s throttle + best-effort catch
// as the heartbeat: observability must never crash the tick.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settingWrites: [] as Array<[string, string]>,
  failSettingWrite: false,
  pingResult: true,
  pingThrows: false,
}));

vi.mock('../../server/domains/kernel/queue', () => ({
  redisQueue: async () => ({
    ping: async () => {
      if (h.pingThrows) throw new Error('redis unreachable');
      return h.pingResult;
    },
  }),
}));

vi.mock('../../server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: vi.fn(async () => 30 * 60_000),
  getTasksPerAgent: vi.fn(async () => 1),
  setSetting: vi.fn(async (key: string, value: string) => {
    if (h.failSettingWrite) throw new Error('db down (setting write)');
    h.settingWrites.push([key, value]);
  }),
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: { query: {} },
}));

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({
      warn: () => {},
      error: () => {},
      success: () => {},
      info: () => {},
      start: () => {},
    }),
  },
}));

import { REDIS_OK_KEY, redisOkState, touchDispatcherRedisOk } from '#server/domains/tasks/dispatcher.service';

beforeEach(() => {
  h.settingWrites.length = 0;
  h.failSettingWrite = false;
  h.pingResult = true;
  h.pingThrows = false;
  redisOkState.lastAt = 0;
});

describe('dispatcher redis-ok stamp (#238)', () => {
  it('a healthy ping stamps the key with an epoch-ms value', async () => {
    await touchDispatcherRedisOk();
    expect(h.settingWrites).toHaveLength(1);
    const [key, value] = h.settingWrites[0]!;
    expect(key).toBe(REDIS_OK_KEY);
    expect(value).toMatch(/^\d+$/);
  });

  it('a failed ping writes NOTHING — the stale stamp is the detection signal', async () => {
    h.pingResult = false;
    await touchDispatcherRedisOk();
    expect(h.settingWrites).toHaveLength(0);
  });

  it('a thrown ping (redisQueue/ping rejection) is swallowed and writes nothing', async () => {
    h.pingThrows = true;
    await expect(touchDispatcherRedisOk()).resolves.toBeUndefined();
    expect(h.settingWrites).toHaveLength(0);
  });

  it('a failed setting write is swallowed (best-effort, never crashes the tick)', async () => {
    h.failSettingWrite = true;
    await expect(touchDispatcherRedisOk()).resolves.toBeUndefined();
  });

  it('re-throttles inside the 30s window (one write max)', async () => {
    await touchDispatcherRedisOk();
    await touchDispatcherRedisOk();
    expect(h.settingWrites).toHaveLength(1);
    redisOkState.lastAt -= 31_000;
    await touchDispatcherRedisOk();
    expect(h.settingWrites).toHaveLength(2);
  });
});
