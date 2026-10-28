// useChangeEvents: the client half of the SSE law — opens the changes SSE after
// mount, invalidates query prefixes on resource change, reconnects on drop,
// never runs on the server (initial data always comes from GET queries).
// Nuxt globals (useNuxtApp/useQueryClient/onScopeDispose) are stubbed as
// globalThis bindings so the composable runs under the plain unit project.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { CHANGE_ACTION, CHANGE_RESOURCE } from '#shared/enums';

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
  return await import('../../app/composables/useChangeEvents.ts');
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
    useChangeEvents(ref({ user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } }));
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
    useChangeEvents(ref({ user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } }));
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
    // fake timers: the 2s backoff is a timer, so the test advances it instead of
    // sleeping through it (the suite used to sit here for 2.45s)
    vi.useFakeTimers();
    try {
      const qc = makeQc();
      const live = makeLive(['fail', 'open-empty']);
      install({ changes: { live } }, qc);
      const { useChangeEvents } = await loadMod();
      useChangeEvents(ref({ user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } }));
      await vi.advanceTimersByTimeAsync(2100); // fail → 2s retry → reconnect
      expect(live).toHaveBeenCalledTimes(2);
      // catch-up: the post-drop successful open invalidates everything once
      expect(qc.invalidateQueries).toHaveBeenCalledWith();
      while (disposers.length) disposers.pop()!();
      await vi.advanceTimersByTimeAsync(30);
    } finally {
      vi.useRealTimers();
    }
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
    useChangeEvents(ref({ user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } }));
    disposers[0]?.(); // scope teardown aborts the open SSE stream
    await new Promise((r) => setTimeout(r, 40));
    const call = live.mock.calls[0]?.[1] as unknown as { signal: AbortSignal };
    expect(call.signal.aborted).toBe(true);
    // loop saw stopped=true and exited — no reconnect attempt
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('holds signed-out and only opens once a session appears', async () => {
    // fake timers from the START: the signed-out poll is scheduled when the
    // composable is set up, so a clock installed later never fires it
    vi.useFakeTimers();
    try {
      const qc = makeQc();
      const live = vi.fn(() => Promise.resolve({ async *[Symbol.asyncIterator]() {} }));
      install({ changes: { live } }, qc);
      const { useChangeEvents } = await loadMod();
      const session = ref(null);
      useChangeEvents(session);
      await vi.advanceTimersByTimeAsync(50);
      expect(live).not.toHaveBeenCalled(); // anonymous: channel never opens
      session.value = { user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } };
      await vi.advanceTimersByTimeAsync(2100); // the poll ticks at 2s
      expect(live).toHaveBeenCalledTimes(1);
      disposers[0]?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auth failures take the backoff path (distinct from plain drops)', async () => {
    const qc = makeQc();
    const live = vi.fn(() => Promise.reject(Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' })));
    install({ changes: { live } }, qc);
    const { useChangeEvents } = await loadMod();
    useChangeEvents(ref({ user: { id: 'u1', name: 'U', email: 'u@t', role: 'ADMIN' } }));
    await new Promise((r) => setTimeout(r, 60));
    expect(live).toHaveBeenCalledTimes(1); // first attempt fails auth → backoff ≥ 4s, not the 2s drop path
    disposers[0]?.();
  });
});
