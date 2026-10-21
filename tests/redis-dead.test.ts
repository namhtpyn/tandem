// Failure arms: hub creation against a dead redis must throw-and-reset (no cached poison),
// and publishChange degrades to local-only when redis is down.
import { describe, expect, it } from 'vitest';

import './api-harness';
import './helpers/pg';
import { CHANGE_ACTION, CHANGE_RESOURCE } from '../shared/enums';
import { env, setEnv } from '../server/domains/kernel/env';

describe('redis failure arms', () => {
  it('queue domain rejects and clears the cache on connection failure', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6390' }); // nothing listens here
    const { redisQueue } = await import('../server/domains/kernel/queue');
    await expect(redisQueue()).rejects.toThrow();
    // cache was cleared by the rejection: a second call retries (and fails) fresh
    await expect(redisQueue()).rejects.toThrow();
    setEnv({ REDIS_URL: undefined });
  });

  it('pubsub domain rejects and clears the cache on connection failure', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6390' });
    const { redisPubsub } = await import('../server/domains/kernel/pubsub');
    await expect(redisPubsub()).rejects.toThrow();
    await expect(redisPubsub()).rejects.toThrow();
    setEnv({ REDIS_URL: undefined });
  });

  it('publishChange stays local-only when the hub publish fails', async () => {
    setEnv({ REDIS_URL: 'redis://127.0.0.1:6390' });
    const { publishChange, changeBus } = await import('../server/domains/kernel/change-bus');
    const seen: string[] = [];
    const unsub = await changeBus.subscribe('change', (e) => seen.push(e.resource));
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE); // hub.publish rejects -> caught -> local bus still fired
    expect(seen).toContain('TASKS');
    unsub();
    setEnv({ REDIS_URL: undefined });
  });
});
