// Cache domain: cache-manager over a redis store. REDIS_URL is REQUIRED
// (validated at boot) — redis is a hard dependency.
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';
import { env } from './env';

export type CacheDomain = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T, ttlSeconds?: number) => Promise<T>;
  del: (key: string) => Promise<boolean>;
  wrap: <T>(key: string, fn: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  close: () => Promise<void>;
};

let domainPromise: Promise<CacheDomain> | null = null;

/** lazily create the cache domain */
export function appCache(): Promise<CacheDomain> {
  domainPromise ??= createCacheDomain().catch((e: unknown) => {
    domainPromise = null;
    throw e;
  });
  return domainPromise;
}

async function createCacheDomain(): Promise<CacheDomain> {
  const url = env.REDIS_URL;
  const raws: Array<{ disconnect: () => void }> = [];
  // fail fast: verify the connection works before handing out the domain
  const { createClient } = await import('redis');
  const ping = createClient({
    url,
    socket: { connectTimeout: 1500, reconnectStrategy: () => new Error('no-retry') },
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
    del: (key) => cache.del(key),
    wrap: (key, fn, ttlSeconds) => cache.wrap(key, fn, ttlSeconds),
    async close() {
      await Promise.allSettled(raws.map((r) => r.disconnect()));
      domainPromise = null;
    },
  };
}
