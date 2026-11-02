// Live-stream re-auth (SPEC "Roles & access", LIVE-STREAM RE-AUTH, #224):
// an SSE stream outlives its open-time check, and the per-request getSession
// latches — so every emit after the re-auth window must re-assert the caller's
// own procedure tier with a FRESH session; revocation/demotion tears the
// stream down instead of leaking snapshots until the client disconnects.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHANGE_ACTION, CHANGE_RESOURCE, ROLE, type Role } from '#shared/enums';

import {
  assertLiveAuthorized,
  changeBus,
  LIVE_REAUTH_MS,
  liveGenerator,
  liveReauthorizer,
  type AuthSessionPayload,
  type LiveGate,
  type ServerContext,
} from '../../server/domains/kernel/kernel';

vi.mock('../../server/domains/kernel/session-origin', () => ({
  isApiKeySession: vi.fn(async (sessionId: string | undefined) => sessionId === 'agent-key'),
}));

function session(role: Role = ROLE.VIEWER, mustChangePassword = false): AuthSessionPayload {
  return {
    sessionId: 's1',
    user: { id: 'u1', name: 'Test', email: 't@x.io', role, mustChangePassword },
  };
}

function ctxFor(gate: LiveGate, resolve: () => Promise<AuthSessionPayload | null>): ServerContext {
  return {
    reqHeaders: undefined,
    liveGate: gate,
    getSession: resolve,
    refreshSession: resolve,
  } as unknown as ServerContext;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const evt = () => ({
  id: '1',
  resource: CHANGE_RESOURCE.TASKS,
  action: CHANGE_ACTION.UPDATE,
  at: new Date().toISOString(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('assertLiveAuthorized', () => {
  it('public streams skip the session lookup entirely', async () => {
    const refresh = vi.fn(async () => null);
    await assertLiveAuthorized(ctxFor({ tier: 'public' }, refresh));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a deleted/revoked session is UNAUTHORIZED', async () => {
    const context = ctxFor({ tier: 'session' }, async () => null);
    await expect(assertLiveAuthorized(context)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a rotation-locked session is FORBIDDEN', async () => {
    const context = ctxFor({ tier: 'session' }, async () => session(ROLE.VIEWER, true));
    await expect(assertLiveAuthorized(context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'password change required',
    });
  });

  it('a demoted admin loses an admin stream', async () => {
    const context = ctxFor({ tier: 'role', roles: [ROLE.ADMIN], humanOnly: false }, async () => session(ROLE.VIEWER));
    await expect(assertLiveAuthorized(context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('session tier admits every authenticated role', async () => {
    for (const role of [ROLE.ADMIN, ROLE.EMPLOYEE, ROLE.VIEWER]) {
      await expect(
        assertLiveAuthorized(ctxFor({ tier: 'session' }, async () => session(role))),
      ).resolves.toBeUndefined();
    }
  });

  it('a role gate admits its own roles', async () => {
    const context = ctxFor({ tier: 'role', roles: [ROLE.ADMIN], humanOnly: false }, async () => session(ROLE.ADMIN));
    await expect(assertLiveAuthorized(context)).resolves.toBeUndefined();
  });

  it('human-only tiers reject an agent credential', async () => {
    const context = ctxFor({ tier: 'role', roles: [ROLE.ADMIN, ROLE.EMPLOYEE], humanOnly: true }, async () => ({
      sessionId: 'agent-key',
      user: { id: 'bot', name: 'Bot', email: 'bot@x.io', role: ROLE.EMPLOYEE },
    }));
    await expect(assertLiveAuthorized(context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'review verdicts are human-only',
    });
  });
});

describe('liveReauthorizer', () => {
  it('checks once per window, not per emit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    const refresh = vi.fn(async () => session());
    const reauthorize = liveReauthorizer(ctxFor({ tier: 'session' }, refresh));

    await reauthorize();
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(Date.now() + LIVE_REAUTH_MS));
    await reauthorize();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('liveGenerator', () => {
  it('stops emitting after the session is revoked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    let current: AuthSessionPayload | null = session();
    const fetch = vi.fn(async () => 1);
    const gen = liveGenerator(
      [CHANGE_RESOURCE.TASKS],
      fetch,
      ctxFor({ tier: 'session' }, async () => current),
    );

    await expect(gen.next()).resolves.toEqual({ value: 1, done: false });

    // inside the window the stream keeps emitting (bounded staleness)
    const inside = gen.next();
    await flush();
    await changeBus.publish('change', evt());
    await expect(inside).resolves.toEqual({ value: 1, done: false });

    // past the window a revoked session ends the stream before yielding
    current = null;
    vi.setSystemTime(new Date(Date.now() + LIVE_REAUTH_MS));
    const after = gen.next();
    await flush();
    await changeBus.publish('change', evt());
    await expect(after).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores events for other resources', async () => {
    const fetch = vi.fn(async () => 'snap');
    const gen = liveGenerator(
      [CHANGE_RESOURCE.VAULT],
      fetch,
      ctxFor({ tier: 'public' }, async () => session()),
    );
    await gen.next();
    const pending = gen.next();
    await flush();
    await changeBus.publish('change', { ...evt(), resource: CHANGE_RESOURCE.TASKS });
    await changeBus.publish('change', { ...evt(), resource: CHANGE_RESOURCE.VAULT });
    await expect(pending).resolves.toEqual({ value: 'snap', done: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
