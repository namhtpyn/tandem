// TICK-ISOLATION LAW (#172): scanOnce never rejects — a findEligible DB failure
// (or any scan-leg error) is caught, logged rate-limited, and turns into `false`.
// The startDispatcher call sites are bare `void scanOnce(...)`; on the bun prod
// runtime an unhandled rejection terminates the whole process (UI + all runs).
// DISPATCHER HEARTBEAT (same origin): the tick stamps settings `dispatcher_last_tick`
// best-effort — throttled to one write per 30s, its own catch, never crashes the tick.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warns: unknown[][] = [];

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({
      warn: (...a: unknown[]) => void warns.push(a),
      error: () => {},
      success: () => {},
      info: () => {},
      start: () => {},
    }),
  },
}));

const h = vi.hoisted(() => ({
  failStatusRead: true,
  settingWrites: [] as Array<[string, string]>,
  failSettingWrite: false,
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskStatuses: {
        findMany: async () => {
          if (h.failStatusRead) throw new Error('db down (statuses read)');
          return [];
        },
      },
    },
  },
}));

vi.mock('../../server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: vi.fn(async () => 30 * 60_000),
  getTasksPerAgent: vi.fn(async () => 1),
  setSetting: vi.fn(async (key: string, value: string) => {
    if (h.failSettingWrite) throw new Error('db down (heartbeat write)');
    h.settingWrites.push([key, value]);
  }),
}));

import {
  DISPATCHER_HEARTBEAT_KEY,
  heartbeatState,
  scanOnce,
  scanWarnState,
  TICK_WARN_INTERVAL_MS,
  touchDispatcherHeartbeat,
} from '#server/domains/tasks/dispatcher.service';

beforeEach(() => {
  warns.length = 0;
  scanWarnState.lastAt = 0;
  heartbeatState.lastAt = 0;
  h.failStatusRead = true;
  h.failSettingWrite = false;
  h.settingWrites.length = 0;
});

describe('scanOnce tick isolation (#172)', () => {
  it('a failing find-eligible DB read resolves false — never rejects', async () => {
    await expect(scanOnce('http://localhost')).resolves.toBe(false);
  });

  it('the failure is logged (never silent)', async () => {
    await scanOnce('http://localhost');
    expect(warns).toHaveLength(1);
    expect(String(warns[0]?.join(' '))).toContain('dispatch scan failed');
    expect(String(warns[0]?.join(' '))).toContain('db down (statuses read)');
  });

  it('repeat scan failures inside the window stay silent (rate limit)', async () => {
    await scanOnce('http://localhost');
    warns.length = 0;
    await scanOnce('http://localhost');
    await scanOnce('http://localhost');
    expect(warns).toHaveLength(0);
  });

  it('a scan failure after the warn window logs again', async () => {
    await scanOnce('http://localhost');
    scanWarnState.lastAt = Date.now() - TICK_WARN_INTERVAL_MS - 1;
    warns.length = 0;
    await scanOnce('http://localhost');
    expect(warns).toHaveLength(1);
  });

  it('a healthy scan with no eligible work resolves false without warnings', async () => {
    h.failStatusRead = false;
    await expect(scanOnce('http://localhost')).resolves.toBe(false);
    expect(warns).toHaveLength(0);
  });
});

describe('dispatcher heartbeat (#172)', () => {
  it('first call stamps the settings key with an epoch-ms value', async () => {
    await touchDispatcherHeartbeat();
    expect(h.settingWrites).toHaveLength(1);
    const [key, value] = h.settingWrites[0]!;
    expect(key).toBe(DISPATCHER_HEARTBEAT_KEY);
    expect(Number(value)).toBeGreaterThan(0);
  });

  it('immediate repeat calls throttle to one write per window', async () => {
    await touchDispatcherHeartbeat();
    await touchDispatcherHeartbeat();
    await touchDispatcherHeartbeat();
    expect(h.settingWrites).toHaveLength(1);
  });

  it('a failed heartbeat write never rejects the tick', async () => {
    h.failSettingWrite = true;
    await expect(touchDispatcherHeartbeat()).resolves.toBeUndefined();
    expect(warns).toHaveLength(0);
  });
});
