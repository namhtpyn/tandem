// app/composables/useAppSession — useState-backed session/config/version state
// and the focus-refresh lifecycle. happy-dom environment; Nuxt auto-imports
// (useState, onMounted…) are stubbed globally in this file's harness.
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ROLE } from '#shared/enums';

// ---- Nuxt runtime stubs ----
type Ref<T> = { value: T };
const stateStore = new Map<string, Ref<unknown>>();
function useStateStub<T>(key: string, init: () => T): Ref<T> {
  if (!stateStore.has(key)) stateStore.set(key, { value: init() });
  return stateStore.get(key) as Ref<T>;
}

const mounted: Array<() => void> = [];
const unmounted: Array<() => void> = [];
let currentFetch: ((url: string) => Promise<unknown>) | null = null;

const g = globalThis as Record<string, unknown>;
g.useState = useStateStub;
g.onMounted = (fn: () => void) => mounted.push(fn);
g.onUnmounted = (fn: () => void) => unmounted.push(fn);
g.$fetch = (url: string) => currentFetch?.(url);
// oRPC client stub for refreshSession
g.useNuxtApp = () => ({
  $client: {
    auth: {
      session: async () => currentSession,
    },
  },
});
let currentSession: unknown = null;

beforeEach(async () => {
  stateStore.clear();
  mounted.length = 0;
  unmounted.length = 0;
  currentFetch = null;
  currentSession = null;
  const m = await import('../../app/composables/useAppSession.ts');
  (m as unknown as { __resetFocusListenerForTests: () => void }).__resetFocusListenerForTests();
});

describe('useAppSession', () => {
  it('defaults: null session, null auth-config, dev version', async () => {
    const m = await import('../../app/composables/useAppSession.ts');
    expect(m.useAppSession().value).toBeNull();
    expect(m.useAuthConfigState().value).toBeNull();
    expect(m.useAppVersion().value).toBe('dev');
  });

  it('shares one state instance per key', async () => {
    const m = await import('../../app/composables/useAppSession.ts');
    m.useAppSession().value = {
      user: { id: 'x', name: 'X', email: 'x@x', role: ROLE.ADMIN },

    };
    expect(m.useAppSession().value?.user.id).toBe('x');
  });
});

describe('useSessionRefreshing', () => {
  it('refreshSession keeps the session on a generic error (only 401 logs out)', async () => {
    const m = await import('../../app/composables/useAppSession.ts');
    m.useAppSession().value = {
      user: { id: 'old', name: 'Old', email: 'o@x', role: ROLE.ADMIN },

    };
    (g.useNuxtApp as () => unknown) = () => ({
      $client: {
        auth: {
          session: async () => {
            throw new Error('boom');
          },
        },
      },
    });
    const { refreshSession } = m.useSessionRefreshing();
    await refreshSession();
    // transient errors must not visually log the user out
    expect(m.useAppSession().value?.user.id).toBe('old');
    // restore the default stub for subsequent tests
    (g.useNuxtApp as () => unknown) = () => ({
      $client: { auth: { session: async () => currentSession } },
    });
  });

  it('refreshSession updates the session via oRPC auth.session', async () => {
    currentSession = {
      user: { id: '00000000-0000-7000-8000-c5ea71554c77', name: 'U', email: 'u@x', role: ROLE.VIEWER },

    };
    const m = await import('../../app/composables/useAppSession.ts');
    const { refreshSession } = m.useSessionRefreshing();
    await refreshSession();
    expect(m.useAppSession().value?.user.id).toBe('00000000-0000-7000-8000-c5ea71554c77');
  });

  it('refreshSession keeps the session on a fetch error (no visual logout)', async () => {
    (g.useNuxtApp as () => unknown) = () => ({
      $client: {
        auth: {
          session: async () => {
            throw new Error('network down');
          },
        },
      },
    });
    const m = await import('../../app/composables/useAppSession.ts');
    m.useAppSession().value = {
      user: { id: 'old', name: 'O', email: 'o@x', role: ROLE.ADMIN },
    };
    const { refreshSession } = m.useSessionRefreshing();
    await expect(refreshSession()).resolves.toBeUndefined();
    expect(m.useAppSession().value?.user.id).toBe('old');
    // restore the default stub for subsequent tests
    (g.useNuxtApp as () => unknown) = () => ({
      $client: { auth: { session: async () => currentSession } },
    });
  });

  it('sees import.meta.client as true under the define', async () => {
    const probe = await import('../../app/composables/useAppSession.ts');
    // if define worked, useSessionRefreshing registers lifecycle hooks; assert via side effect
    const before = mounted.length;
    probe.useSessionRefreshing();
    expect(mounted.length).toBeGreaterThan(before);
  });

  it('binds exactly one tab-lifetime window focus listener on mount', async () => {
    const add = vi.fn();
    const remove = vi.fn();
    (globalThis as unknown as { window: unknown }).window = { addEventListener: add, removeEventListener: remove };
    const m = await import('../../app/composables/useAppSession.ts');
    m.useSessionRefreshing();
    expect(mounted).toHaveLength(1);
    mounted[0]!();
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('focus', expect.any(Function));
    // singleton law: a second call site must not add another listener
    m.useSessionRefreshing();
    mounted[1]!();
    expect(add).toHaveBeenCalledTimes(1);
  });

describe('isUnauthorizedError', () => {
  it('detects code, status and statusCode shapes; rejects everything else', async () => {
    const m = await import('../../app/composables/useAppSession.ts');
    expect(m.isUnauthorizedError({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(m.isUnauthorizedError({ code: 'FORBIDDEN' })).toBe(true);
    expect(m.isUnauthorizedError({ status: 401 })).toBe(true);
    expect(m.isUnauthorizedError({ statusCode: 403 })).toBe(true);
    expect(m.isUnauthorizedError(new Error('boom'))).toBe(false);
    expect(m.isUnauthorizedError(null)).toBe(false);
  });

  it('refreshSession clears the session ONLY on an explicit auth rejection', async () => {
    (g.useNuxtApp as () => unknown) = () => ({
      $client: {
        auth: {
          session: async () => {
            throw Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' });
          },
        },
      },
    });
    const m = await import('../../app/composables/useAppSession.ts');
    m.useAppSession().value = { user: { id: 'old', name: 'O', email: 'o@x', role: ROLE.ADMIN } };
    const { refreshSession } = m.useSessionRefreshing();
    await refreshSession();
    expect(m.useAppSession().value).toBeNull();
    // restore the default stub
    (g.useNuxtApp as () => unknown) = () => ({
      $client: { auth: { session: async () => currentSession } },
    });
  });
});
});
