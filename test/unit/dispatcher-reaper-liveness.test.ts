// REAPER LIVENESS LAW (#147): the reaper's own liveness is stated + verified —
// a failed sweep logs a rate-limited warning (never silent), boot's dispatcher
// start retries on a fixed machine interval until the queue is reachable, and a
// null start (TANDEM_NO_DISPATCHER) stops retrying without an error.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warns: unknown[][] = [];
const errors: unknown[][] = [];
const successes: unknown[][] = [];

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({
      warn: (...a: unknown[]) => void warns.push(a),
      error: (...a: unknown[]) => void errors.push(a),
      success: (...a: unknown[]) => void successes.push(a),
      info: () => {},
      start: () => {},
    }),
  },
}));

vi.mock('../../server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: vi.fn(async () => {
    throw new Error('db down (settings read)');
  }),
  getTasksPerAgent: vi.fn(async () => 1),
}));

import {
  DISPATCHER_BOOT_RETRY_MS,
  REAPER_WARN_INTERVAL_MS,
  reapStaleRuns,
  reaperWarnState,
  ensureDispatcherRunning,
} from '#server/domains/tasks/dispatcher.service';

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  successes.length = 0;
  reaperWarnState.lastAt = 0;
});

describe('reaper sweep failure logging (#147)', () => {
  it('a failed sweep logs a warning and still returns 0', async () => {
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(0);
    expect(warns).toHaveLength(1);
    expect(String(warns[0]?.join(' '))).toContain('reaper sweep failed');
    expect(String(warns[0]?.join(' '))).toContain('db down (settings read)');
  });

  it('repeat failures inside the window stay silent (rate limit)', async () => {
    await reapStaleRuns();
    warns.length = 0;
    await reapStaleRuns();
    await reapStaleRuns();
    expect(warns).toHaveLength(0);
  });

  it('a failure after the window warns again (persistent failure stays visible)', async () => {
    await reapStaleRuns();
    warns.length = 0;
    reaperWarnState.lastAt = Date.now() - REAPER_WARN_INTERVAL_MS - 1;
    await reapStaleRuns();
    expect(warns).toHaveLength(1);
  });
});

describe('boot dispatcher retry (#147)', () => {
  it('a failed start logs an error and retries on the fixed interval until success', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const dispatcherStop = vi.fn();
      const start = vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('connect ECONNREFUSED redis:6379');
        return dispatcherStop;
      });
      const stopLoop = ensureDispatcherRunning({ start, intervalMs: DISPATCHER_BOOT_RETRY_MS });

      // initial attempt (fails) — flush the promise chain
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.[0])).toContain('dispatcher failed to start');
      expect(String(errors[0]?.[0])).toContain('retrying every 30s');

      // retries continue on the fixed interval
      await vi.advanceTimersByTimeAsync(DISPATCHER_BOOT_RETRY_MS);
      expect(attempts).toBe(2);
      expect(errors).toHaveLength(2);

      // success on the third attempt: retries stop, dispatcher stop fn retained
      await vi.advanceTimersByTimeAsync(DISPATCHER_BOOT_RETRY_MS);
      expect(attempts).toBe(3);
      expect(successes).toHaveLength(1);
      const errCount = errors.length;

      await vi.advanceTimersByTimeAsync(DISPATCHER_BOOT_RETRY_MS * 4);
      expect(attempts).toBe(3); // no further attempts once started
      expect(errors).toHaveLength(errCount);

      stopLoop();
      expect(dispatcherStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a null start (TANDEM_NO_DISPATCHER) schedules no retries and logs no error', async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(async () => null);
      const stopLoop = ensureDispatcherRunning({ start, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(0);
      stopLoop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the returned stop fn ends a still-failing retry loop', async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(async () => {
        throw new Error('redis down');
      });
      const stopLoop = ensureDispatcherRunning({ start, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(1);
      stopLoop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(start).toHaveBeenCalledTimes(1); // no attempts after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
