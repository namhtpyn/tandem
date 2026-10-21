// Pubsub domain: cross-replica change-event fanout over Redis pub/sub via
// @orpc/publisher. Null when REDIS_URL is unset — the local memory bus alone
// already serves single-replica deployments.
import { RedisPublisher } from '@orpc/publisher/redis';
import { env } from './env';

export type PubsubDomain = {
  publish: (channel: string, message: string) => Promise<void>;
  subscribe: (channel: string, handler: (message: string) => void) => Promise<void>;
  close: () => Promise<void>;
};

let domain: PubsubDomain | null = null;

/** lazily create the pubsub domain; returns null when REDIS_URL is unset */
export function redisPubsub(): Promise<PubsubDomain | null> {
  if (!process.env.REDIS_URL) return Promise.resolve(null);
  if (!domain)
    domain = createPubsubDomain().catch((e: unknown) => {
      domain = null;
      throw e;
    }) as unknown as PubsubDomain;
  return Promise.resolve(domain);
}

async function createPubsubDomain(): Promise<PubsubDomain> {
  const [{ createClient }] = await Promise.all([import('redis')]);

  const url = process.env.REDIS_URL ?? '';
  // fail fast: verify the connection works before handing out the domain
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

  const raw = createClient({ url, socket: { connectTimeout: 2000 } });
  raw.on('error', () => {});
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
      domain = null;
    },
  };
}
