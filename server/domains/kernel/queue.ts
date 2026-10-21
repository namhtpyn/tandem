// Message-queue domain: BullMQ per-agent dispatch queues (durable, retrying).
// REDIS_URL is REQUIRED (validated at boot) — redis is a hard dependency.
import type { ChangeAction, ChangeResource } from './change-bus';
import { env } from './env';

export type QueueDomain = {
  queue: <T>(
    name: string,
    process: (data: T) => Promise<void>,
    opts?: { concurrency?: number; attempts?: number },
  ) => Promise<{ close: () => Promise<void> }>;
  enqueue: <T>(
    name: string,
    data: T,
    opts?: { delayMs?: number; attempts?: number; jobId?: string; removeOnComplete?: boolean },
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
  const url = process.env.REDIS_URL ?? '';

  const makeRaw = () =>
    createClient({
      url,
      socket: { connectTimeout: 2000 },
    });
  type Raw = ReturnType<typeof makeRaw>;

  const connectRaw = async (): Promise<Raw> => {
    const raw = makeRaw();
    raw.on('error', () => {});
    await raw.connect();
    return raw;
  };

  const queues = new Map<string, InstanceType<typeof Queue>>();
  const workers: Array<{ close: () => Promise<void> }> = [];
  const raws: Raw[] = [];

  // fail fast: verify the connection works before handing out the domain
  const ping = createClient({ url, socket: { connectTimeout: 1500, reconnectStrategy: () => new Error('no-retry') } });
  ping.on('error', () => {});
  try {
    await ping.connect();
    await ping.ping();
  } finally {
    ping.disconnect();
  }

  // one adapter per role; bullmq duplicates it internally for blocking commands
  const workerConn = createNodeRedisClient(await connectRaw());
  raws.push(workerConn as unknown as Raw);

  return {
    async queue(name, process, opts) {
      const q = queues.get(name) ?? new Queue(name, { connection: workerConn });
      queues.set(name, q);
      const w = new Worker(
        name,
        async (job: { data: unknown }) => {
          await (process as (d: unknown) => Promise<void>)(job.data);
        },
        {
          connection: workerConn,
          concurrency: opts?.concurrency ?? 1,
          attempts: opts?.attempts ?? 1,
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

/** change event wire types — shared by queue payloads and the change-bus publisher */
export type ChangeWire = { resource: ChangeResource; action: ChangeAction; id: string; at: string };
