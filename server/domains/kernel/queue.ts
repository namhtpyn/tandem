// Message-queue domain: BullMQ per-agent dispatch queues (durable, retrying).
// REDIS_URL is REQUIRED (validated at boot) — redis is a hard dependency.
import { env } from './env';

/** node-redis emits 'error' on every dropped/reconnecting socket — swallow to keep the process alive */
export function swallowRedisError(_e: unknown) {
  /* a dead redis surfaces on the next await, not as an unhandled event */
}

export type QueueDomain = {
  queue: <T>(
    name: string,
    process: (data: T, meta: { attempt: number; maxAttempts: number }) => Promise<void>,
    opts?: {
      concurrency?: number;
      attempts?: number;
      /** custom retry-delay fn — jobs added with `backoff: { type: 'custom' }` resolve
       * their delay through this (BullMQ Worker settings.backoffStrategy) */
      backoffStrategy?: (
        attemptsMade: number,
        type: string,
        err: Error,
        job: { data: unknown },
      ) => Promise<number> | number;
    },
  ) => Promise<{ close: () => Promise<void> }>;
  enqueue: <T>(
    name: string,
    data: T,
    opts?: {
      delayMs?: number;
      attempts?: number;
      jobId?: string;
      removeOnComplete?: boolean;
      backoff?: { type: 'fixed' | 'exponential' | 'custom'; delay?: number };
    },
  ) => Promise<string>;
  close: () => Promise<void>;
};

let domainPromise: Promise<QueueDomain> | null = null;

/** lazily create the queue domain; REDIS_URL is validated at boot */
export function redisQueue(): Promise<QueueDomain> {
  domainPromise ??= createQueueDomain().catch((e: unknown) => {
    domainPromise = null;
    throw e;
  });
  return domainPromise;
}

async function createQueueDomain(): Promise<QueueDomain> {
  const [{ createClient }, { Queue, Worker, createNodeRedisClient }] = await Promise.all([
    import('redis'),
    import('bullmq'),
  ]); // dynamic form keeps cold-start lazy when REDIS_URL is unset
  const url = env.REDIS_URL;

  const makeRaw = () =>
    createClient({
      url,
      // long-lived: a redis blip must reconnect, not brick enqueues for the process
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries: number) => (retries > 3 ? new Error('no-retry') : Math.min(retries * 200, 1_000)),
      },
    });
  type Raw = ReturnType<typeof makeRaw>;

  const connectRaw = async (): Promise<Raw> => {
    const raw = makeRaw();
    raw.on('error', swallowRedisError);
    await raw.connect();
    return raw;
  };

  const queues = new Map<string, InstanceType<typeof Queue>>();
  const workers: Array<{ close: () => Promise<void> }> = [];
  const raws: Raw[] = [];

  // fail fast: verify the connection works before handing out the domain.
  // 15s (not 5s): CI runners under coverage starve the loop and a localhost TCP
  // connect + ping legitimately takes longer than 5s there (run #40 'no-retry')
  const ping = createClient({
    url,
    socket: { connectTimeout: 15_000, reconnectStrategy: () => new Error('no-retry') },
  });
  ping.on('error', swallowRedisError);
  try {
    await ping.connect();
    await ping.ping();
  } finally {
    ping.disconnect();
  }

  // one adapter per role; bullmq duplicates it internally for blocking commands
  // long-lived connection: reconnect with capped backoff — a redis blip must not
  // brick enqueues for the rest of the process (no-retry would)
  const workerConn = createNodeRedisClient(await connectRaw());
  workerConn.on('error', swallowRedisError);
  raws.push(workerConn as unknown as Raw);

  return {
    async queue(name, process, opts) {
      const q = queues.get(name) ?? new Queue(name, { connection: workerConn });
      queues.set(name, q);
      const w = new Worker(
        name,
        async (job: { data: unknown; attemptsMade: number; opts: { attempts?: number } }) => {
          // attempt = 1-based execution number (BullMQ attemptsMade is 0-based during
          // a run); the processor uses it for run-level retry bookkeeping
          await (process as (d: unknown, m: { attempt: number; maxAttempts: number }) => Promise<void>)(job.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 1,
          });
        },
        {
          connection: workerConn,
          concurrency: opts?.concurrency ?? 1,
          attempts: opts?.attempts ?? 1,
          // custom retry-delay computation (run-level retry law, 2026-10-28): the
          // owner ladder (60s/5m/15m + quota jump) is a function of the FAILED
          // attempt's context, so the worker carries the strategy the jobs reference
          settings: opts?.backoffStrategy ? { backoffStrategy: opts.backoffStrategy } : undefined,
        } as import('bullmq').WorkerOptions,
      );
      const handle = { close: () => w.close() };
      workers.push(handle);
      return handle;
    },
    async enqueue(name, data, opts) {
      const q = queues.get(name) ?? new Queue(name, { connection: workerConn });
      queues.set(name, q);
      // jobId = idempotency key: bullmq rejects a duplicate add while a job with
      // the same id waits/runs — dispatch uses the RUN id so duplicates of one
      // dispatch intent can't stack while leaving later intents free to enqueue
      const job = await q.add('job', data, {
        jobId: opts?.jobId,
        delay: opts?.delayMs ?? 0,
        attempts: opts?.attempts ?? 1,
        backoff: opts?.backoff ?? { type: 'exponential', delay: 1000 },
        // with jobId dedup, a KEPT completed job would block re-dispatch of the
        // same task until it ages out — dispatch queues remove immediately
        removeOnComplete: opts?.removeOnComplete ? true : 100,
        // same for FAILED jobs: a long-kept failed job PERMANENTLY dedupes the
        // same id — free the id quickly (50 kept max) so retries can re-enqueue
        removeOnFail: { count: 50 },
      });
      /* v8 ignore next -- bullmq always assigns an id */
      return job.id ?? '';
    },
    async close() {
      await Promise.allSettled([
        ...workers.map((w) => w.close()),
        ...[...queues.values()].map((q) => q.close()),
        ...raws.map((r) => r.disconnect()),
      ]);
      domainPromise = null;
    },
  };
}
