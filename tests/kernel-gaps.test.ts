// coverage-repair: arms the merge-era work added — dead-redis domains, status
// guards, resync catch, folder list
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './helpers/pg';
import { env, setEnv } from '../server/domains/kernel/env';
import { resetSchema } from './helpers/pg';

const prevRedis = () => env.REDIS_URL;

describe('cache domain against a dead redis', () => {
  it('createCacheDomain rejects (fail-fast boot contract)', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6391' }); // nothing listens here
    vi.resetModules();
    try {
      const { appCache } = await import('../server/domains/kernel/cache');
      await expect(appCache()).rejects.toThrow();
    } finally {
      setEnv({ REDIS_URL: prevRedis() });
      vi.resetModules();
    }
  });

});

describe('statuses.save guards', () => {
  it('rejects the reserved id "new"', async () => {
    const { appRouter } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    const context = buildServerContext(new Headers());
    (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
      user: { id: 'u', name: 'a', email: 'a@a', role: 'ADMIN' },
    });
    const { call } = await import('@orpc/server');
    let node: Record<string, unknown> = appRouter as unknown as Record<string, unknown>;
    for (const k of ['statuses', 'save']) node = node[k] as Record<string, unknown>;
    await expect(
      call(node as unknown as Parameters<typeof call>[0], { id: 'new', name: 'X' }, {
        context,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('statuses.save transition guards', () => {
  it('rejects unknown status ids in transitions', async () => {
    const { appRouter } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    const context = buildServerContext(new Headers());
    (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
      user: { id: 'u', name: 'a', email: 'a@a', role: 'ADMIN' },
    });
    const { call } = await import('@orpc/server');
    let node: Record<string, unknown> = appRouter as unknown as Record<string, unknown>;
    for (const k of ['statuses', 'save']) node = node[k] as Record<string, unknown>;
    await expect(
      call(node as unknown as Parameters<typeof call>[0], { name: 'X', nextIds: ['nope-1'] }, {
        context,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('onDispatcherSettingsChanged with a dead redis', () => {
  it('resolves (best-effort by law)', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6391' });
    const { onDispatcherSettingsChanged } = await import('../server/domains/tasks/dispatcher.service');
    await expect(onDispatcherSettingsChanged()).resolves.toBeUndefined();
  });
});
