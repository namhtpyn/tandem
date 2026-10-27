// Pubsub domain: cross-replica change-event fanout over Redis pub/sub via
// @orpc/publisher. REDIS_URL is REQUIRED (validated at boot) — redis is a
// hard dependency.
import { RedisPublisher } from '@orpc/publisher/redis';

import { env } from './env';

/** node-redis emits 'error' on every dropped/reconnecting socket — swallow to keep the process alive */
export function swallowRedisError(_e: unknown) {
  /* a dead redis surfaces on the next await, not as an unhandled event */
}

export type PubsubDomain = {
  publish: (channel: string, message: string) => Promise<void>;
  subscribe: (channel: string, handler: (message: string) => void) => Promise<void>;
  close: () => Promise<void>;
};

let domainPromise: Promise<PubsubDomain> | null = null;

/** lazily create the pubsub domain; REDIS_URL is validated at boot */
export function redisPubsub(): Promise<PubsubDomain> {
  domainPromise ??= createPubsubDomain().catch((e: unknown) => {
    domainPromise = null;
    throw e;
  });
  return domainPromise;
}

async function createPubsubDomain(): Promise<PubsubDomain> {
  const { createClient } = await import('redis');

  const url = env.REDIS_URL;
  // fail fast: verify the connection works before handing out the domain
  const ping = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries: number) => (retries > 3 ? new Error('no-retry') : Math.min(retries * 200, 1_000)),
    },
  });
  ping.on('error', swallowRedisError);
  try {
    await ping.connect();
    await ping.ping();
  } finally {
    ping.disconnect();
  }

  const raw = createClient({ url, socket: { connectTimeout: 2000 } });
  raw.on('error', swallowRedisError);
  await raw.connect();
  // pub/sub takes over a connection — publisher needs a dedicated subscriber
  // payload must be an object per @orpc/publisher — string message rides inside `raw`
  const publisher = new RedisPublisher<Record<string, { raw: string }>>(raw, {
    subscriber: raw.duplicate(),
  });

  const unsubs: Array<() => Promise<void>> = [];

  return {
    async publish(channel, message) {
      await publisher.publish(channel, { raw: message });
    },
    async subscribe(channel, handler) {
      const unsub = await publisher.subscribe(channel, (m) => handler(m.raw));
      unsubs.push(unsub);
    },
    async close() {
      await Promise.allSettled(unsubs.map((u) => u()));
      raw.disconnect();
      domainPromise = null;
    },
  };
}
