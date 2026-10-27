import KeyvRedis from '@keyv/redis';
// Cache domain: cache-manager over a redis store. REDIS_URL is REQUIRED
// (validated at boot) — redis is a hard dependency.
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';

import { env } from './env';

export type CacheDomain = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T, ttlSeconds?: number) => Promise<T>;
};

let domainPromise: Promise<CacheDomain> | null = null;

/** lazily create the cache domain */
/** drop the memoized domain so the next appCache() reconnects (dead-redis recovery) */
export function resetCacheDomain(e: unknown): never {
  domainPromise = null;
  throw e;
}

export function appCache(): Promise<CacheDomain> {
  domainPromise ??= createCacheDomain().catch(resetCacheDomain);
  return domainPromise;
}

async function createCacheDomain(): Promise<CacheDomain> {
  const url = env.REDIS_URL;
  const raws: Array<{ disconnect: () => void }> = [];
  // fail fast: verify the connection works before handing out the domain
  const { createClient } = await import('redis');
  // the ping's fail arms are covered by the dead-redis reject test (appCache)
  /* v8 ignore next 4 -- node-redis socket internals fire the strategy, not our code */
  const ping = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries: number) => (retries > 3 ? new Error('no-retry') : Math.min(retries * 200, 1_000)),
    },
  });
  ping.on('error', () => {});
  try {
    await ping.connect();
    await ping.ping();
  } finally {
    ping.disconnect();
  }

  const keyvRedis = new KeyvRedis(url);
  raws.push(keyvRedis);
  const store = new Keyv({ store: keyvRedis, ttl: 0 });
  const cache = createCache({ stores: [store] });

  return {
    get: (key) => cache.get(key),
    set: (key, value, ttlSeconds) => cache.set(key, value, ttlSeconds),
  };
}
