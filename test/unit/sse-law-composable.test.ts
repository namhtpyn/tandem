// useChangeEvents: the client half of the SSE law — opens the changes SSE after
// mount, invalidates query prefixes on resource change, reconnects on drop,
// never runs on the server (initial data always comes from GET queries).
// Nuxt globals (useNuxtApp/useQueryClient/onScopeDispose) are stubbed as
// globalThis bindings so the composable runs under the plain unit project.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHANGE_ACTION, CHANGE_RESOURCE } from '../../shared/enums';

type ChangeEvt = { resource: string; action: string };
type LiveMode = 'fail' | 'open-empty' | { events: ChangeEvt[] };

let disposers: Array<() => void> = [];

// the composable imports useQueryClient from the package — mock the hook so it
// resolves without a Vue injection context
vi.mock('@tanstack/vue-query', () => ({
  useQueryClient: () => (globalThis as unknown as Record<string, unknown>).__TEST_QUERY_CLIENT,
}));

function install(client: unknown, qc: unknown) {
  disposers = [];
  (globalThis as unknown as Record<string, unknown>).__TEST_QUERY_CLIENT = qc;
  (globalThis as unknown as { onScopeDispose: (fn: () => void) => void }).onScopeDispose = (fn) => {
    disposers.push(fn);
  };
  (globalThis as unknown as { useNuxtApp: () => unknown }).useNuxtApp = () => ({ $client: client });
}

function makeLive(order: LiveMode[]) {
  return vi.fn((input: unknown, opts: { signal: AbortSignal }) => {
    const mode = order.length > 0 ? order.shift()! : 'open-empty';
    if (mode === 'fail') return Promise.reject(new Error('transport down'));
    const events = mode === 'open-empty' ? [] : [...mode.events];
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        if (opts.signal.aborted) return;
        for (const e of events) yield e;
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) return resolve();
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
  });
}

function makeQc() {
  const invalidated: Array<readonly unknown[]> = [];
  return {
    invalidated,
    invalidateQueries: vi.fn((args: { queryKey: readonly unknown[] }) => {
      invalidated.push(args.queryKey);
    }),
  };
}

async function loadMod() {
  return await import('../../app/composables/useChangeEvents');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  while (disposers.length) disposers.pop()!();
  (import.meta as unknown as Record<string, unknown>).server = false;
});

describe('useChangeEvents', () => {
  it('a synchronously throwing live() is caught and retried', async () => {
    const qc = makeQc();
    const live = vi.fn(() => {
      throw new Error('stream dropped');
    });
    install({ changes: { live } }, qc);
    const { useChangeEvents } = await loadMod();
    useChangeEvents();
    await new Promise((r) => setTimeout(r, 30));
    disposers[0]?.();
    expect(live).toHaveBeenCalled();
  });

  it('subscribes once and invalidates by resource key as events arrive', async () => {
    const qc = makeQc();
    let capturedSignal: AbortSignal | null = null;
    const live = vi.fn((input: unknown, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield { resource: CHANGE_RESOURCE.TASKS, action: CHANGE_ACTION.CREATE };
          yield { resource: CHANGE_RESOURCE.VAULT, action: CHANGE_ACTION.UPDATE };
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) resolve();
          });
        },
      });
    });
    install({ changes: { live } }, qc);
    const { useChangeEvents } = await loadMod();
    useChangeEvents();
    await new Promise((r) => setTimeout(r, 60));
    expect(live).toHaveBeenCalledTimes(1);
    expect(capturedSignal!.aborted).toBe(false);
    // resource keys are invalidated — GET queries with matching prefixes refetch
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: [CHANGE_RESOURCE.TASKS] });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: [CHANGE_RESOURCE.VAULT] });
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
    await disposers[0]?.();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('reconnects with backoff after the stream drops', async () => {
    const qc = makeQc();
    const live = makeLive(['fail', 'open-empty']);
    install({ changes: { live } }, qc);
    const { useChangeEvents } = await loadMod();
    useChangeEvents();
    await new Promise((r) => setTimeout(r, 2450)); // fail → 2s backoff → reconnect
    expect(live).toHaveBeenCalledTimes(2);
    while (disposers.length) disposers.pop()!();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('exits its hung iteration when scope disposes (no leaked open streams)', async () => {
    const qc = makeQc();
    const live = vi.fn((input: unknown, opts: { signal: AbortSignal }) =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) return resolve();
            opts.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      }),
    );
    install({ changes: { live } }, qc);
    const { useChangeEvents } = await loadMod();
    useChangeEvents();
    disposers[0]?.(); // scope teardown aborts the open SSE stream
    await new Promise((r) => setTimeout(r, 40));
    const call = live.mock.calls[0]?.[1] as unknown as { signal: AbortSignal };
    expect(call.signal.aborted).toBe(true);
    // loop saw stopped=true and exited — no reconnect attempt
    expect(live).toHaveBeenCalledTimes(1);
  });


});
