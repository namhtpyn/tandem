// coverage-repair: arms the merge-era work added — dead-redis domains, status
// guards, resync catch, folder list
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './helpers/pg';
import { env, setEnv } from '../server/domains/kernel/env';
import { resetSchema } from './helpers/pg';

const origRedis = env.REDIS_URL;

describe('cache domain against a dead redis', () => {
  it('createCacheDomain rejects (fail-fast boot contract)', async () => {
    const { appCache } = await import('../server/domains/kernel/cache');
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6391' }); // nothing listens here
    try {
      await expect(appCache()).rejects.toThrow();
    } finally {
      setEnv({ REDIS_URL: origRedis });
    }
  });

});

describe('cache lifecycle arms', () => {


  it('resetCacheDomain drops the memoized domain and rethrows', async () => {
    const { resetCacheDomain } = await import('../server/domains/kernel/cache');
    expect(() => resetCacheDomain(new Error('boom'))).toThrow('boom');
  });


});

describe('statuses.save guards', () => {
  it('rejects the reserved id "new" with a real session', async () => {
    const { makeProcCaller } = await import('./helpers/procs');
    const { ROLE } = await import('../shared/enums');
    const caller = await makeProcCaller({ id: '00000000-0000-7000-8000-00000000c0de', name: 'A', email: 'a@tandem.local', role: ROLE.ADMIN });
    await expect(caller('statuses.save', { id: 'new', name: 'X', position: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects unknown status ids in transitions', async () => {
    const { makeProcCaller } = await import('./helpers/procs');
    const { ROLE } = await import('../shared/enums');
    const caller = await makeProcCaller({ id: '00000000-0000-7000-8000-00000000c0de', name: 'A', email: 'a@tandem.local', role: ROLE.ADMIN });
    await expect(caller('statuses.save', { name: 'X', position: 2, nextIds: ['nope-1'] })).rejects.toThrow(
      /unknown status in transitions/,
    );
  });
});

describe('onDispatcherSettingsChanged with a dead redis', () => {
  it('resolves (best-effort by law)', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6391' });
    const { onDispatcherSettingsChanged } = await import('../server/domains/tasks/dispatcher.service');
    await expect(onDispatcherSettingsChanged()).resolves.toBeUndefined();
  });

describe('redis socket error swallow', () => {
  it('pubsub + queue swallows are no-ops', async () => {
    const ps = await import('../server/domains/kernel/pubsub');
    const q = await import('../server/domains/kernel/queue');
    expect(() => ps.swallowRedisError(new Error('drop'))).not.toThrow();
    expect(() => q.swallowRedisError(new Error('drop'))).not.toThrow();
  });
});
});
