// Redis connection + queue/pubsub hub (optional). When REDIS_URL is set, Tandem uses:
//   - BullMQ per-agent queues for task dispatch (durable, retrying, concurrency-1 per agent)
//   - Redis pub/sub to fan change-bus events across replicas
//   - the shared redis as a cache where useful
// When unset (local dev, unit tests), everything falls back to in-memory behavior.
import type { ChangeAction, ChangeResource, ChangeEvent } from './change-bus'

/** read REDIS_URL lazily so tests (and compose) can set it after module load */
export function redisUrl(): string {
  return process.env.REDIS_URL ?? ''
}

export type RedisHub = {
  queue: <T>(name: string, process: (data: T) => Promise<void>, opts?: { concurrency?: number, attempts?: number }) => Promise<{ close: () => Promise<void> }>
  enqueue: <T>(name: string, data: T, opts?: { delayMs?: number, attempts?: number, jobId?: string, removeOnComplete?: boolean }) => Promise<string>
  publish: (channel: string, message: string) => Promise<void>
  subscribe: (channel: string, handler: (message: string) => void) => Promise<void>
  cacheGet: (key: string) => Promise<string | null>
  cacheSet: (key: string, value: string, ttlSeconds: number) => Promise<void>
  close: () => Promise<void>
}

let hub: RedisHub | null = null

/** lazily create the shared hub; returns null when REDIS_URL is unset */
export function redisHub(): Promise<RedisHub | null> {
  if (!redisUrl()) return Promise.resolve(null)
  if (!hub) hub = createHub().catch((e: unknown) => { hub = null; throw e }) as unknown as RedisHub
  return Promise.resolve(hub)
}

async function createHub(): Promise<RedisHub> {
  const [{ default: Redis }, { Queue, Worker }] = await Promise.all([
    import('ioredis'),
    import('bullmq'),
  ]) // static deps; dynamic form keeps cold-start lazy when REDIS_URL is unset
  // bullmq accepts { url }; ioredis wants the url as first arg
  // bullmq requires maxRetriesPerRequest: null (it manages retries itself)
  const connection = { url: redisUrl(), maxRetriesPerRequest: null, connectTimeout: 2000 }
  const queues = new Map<string, InstanceType<typeof Queue>>()
  const workers: Array<{ close: () => Promise<void> }> = []
  const subs: Array<InstanceType<typeof Redis>> = []
  const pubs: Array<InstanceType<typeof Redis>> = []

  // fail fast: verify the connection works before handing out the hub.
  // retryStrategy null + a swallowed error listener: a dead endpoint must
  // reject once and leave NOTHING retrying in the background (unhandled
  // 'error' events at process exit otherwise).
  const ping = new Redis(redisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null })
  ping.on('error', () => {})
  try {
    await ping.connect()
    await ping.ping()
  }
  finally {
    ping.disconnect()
  }

  return {
    async queue(name, process, opts) {
      const q = queues.get(name) ?? new Queue(name, { connection })
      queues.set(name, q)
      const w = new Worker(name, (async (job: { data: unknown }) => {
        await (process as (d: unknown) => Promise<void>)(job.data)
      }), {
        connection,
        concurrency: opts?.concurrency ?? 1,
        attempts: opts?.attempts ?? 1,
      } as import('bullmq').WorkerOptions)
      const handle = { close: () => w.close() }
      workers.push(handle)
      return handle
    },
    async enqueue(name, data, opts) {
      const q = queues.get(name) ?? new Queue(name, { connection })
      queues.set(name, q)
      // jobId = idempotency key: bullmq rejects a duplicate add while a job with
      // the same id waits/runs — dispatch uses the taskId so duplicates can't stack
      const job = await q.add('job', data, {
        jobId: opts?.jobId,
        delay: opts?.delayMs ?? 0,
        attempts: opts?.attempts ?? 1,
        backoff: { type: 'exponential', delay: 1000 },
        // with jobId dedup, a KEPT completed job would block re-dispatch of the
        // same task until it ages out — dispatch queues remove immediately
        removeOnComplete: opts?.removeOnComplete ? true : 100,
        removeOnFail: 500,
      })
      /* v8 ignore next -- bullmq always assigns an id */
      return job.id ?? ''
    },
    async publish(channel, message) {
      const p = new Redis(redisUrl())
      pubs.push(p)
      await p.publish(channel, message)
    },
    async subscribe(channel, handler) {
      const s = new Redis(redisUrl())
      subs.push(s)
      await s.subscribe(channel)
      s.on('message', (_c, m) => handler(m))
    },
    async cacheGet(key) {
      const p = new Redis(redisUrl())
      pubs.push(p)
      return p.get(key)
    },
    async cacheSet(key, value, ttlSeconds) {
      const p = new Redis(redisUrl())
      pubs.push(p)
      await p.set(key, value, 'EX', ttlSeconds)
    },
    async close() {
      await Promise.allSettled([
        ...workers.map(w => w.close()),
        ...[...queues.values()].map(q => q.close()),
        ...subs.map(s => s.disconnect()),
        ...pubs.map(p => p.disconnect()),
      ])
      hub = null
    },
  }
}

/** change-bus fanout channel */
export const CHANGE_CHANNEL = 'tandem:changes'

/** serialize/deserialize change events over the wire */
export function encodeChange(e: ChangeEvent): string {
  return JSON.stringify(e)
}
export function decodeChange(raw: string): ChangeEvent {
  const e = JSON.parse(raw) as { resource: ChangeResource, action: ChangeAction, id: string, at: string }
  return { id: e.id, resource: e.resource, action: e.action, at: e.at }
}
