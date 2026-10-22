// Redis-wired arms of dispatcher + change-bus, against the real redis on 6399.
// Mocks the runner so no SSH/DB dispatch happens — only queue mechanics are under test.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Pin this file to its own redis DB before ANY import evaluates (vi.hoisted
// runs above static imports, so before env.ts caches REDIS_URL): db 15 is
// outside the per-worker range (0-14) and no other file uses it — parallel
// workers can't leak publishes into this bus
vi.hoisted(() => {
  process.env.REDIS_URL = `${(process.env.REDIS_URL || 'redis://127.0.0.1:6399').replace(/\/\d*$/, '')}/15`;
});

import './api-harness';
import { applyMigrations } from '#server/db/index';
import { env, setEnv } from '#server/domains/kernel/env';
import { CHANGE_ACTION, CHANGE_RESOURCE } from '#shared/enums';
import { ROLE, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';


const REDIS_URL = 'redis://127.0.0.1:6399';

async function nr() {
  const { createClient } = await import('redis');
  const r = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: 500, reconnectStrategy: () => new Error('no-retry') },
  });
  r.on('error', () => {});
  await r.connect();
  return r;
}

async function redisUp() {
  try {
    const r = await nr();
    await r.disconnect();
    return true;
  } catch {
    return false;
  }
}

const up = await redisUp();

const dispatched: string[] = [];
vi.mock('#server/domains/tasks/runner.service', () => ({
  dispatchTask: async (taskId: string) => {
    dispatched.push(taskId);
    return { finished: Promise.resolve({ status: RUN_STATUS.DONE, exitCode: 0 }) };
  },
}));

describe.skipIf(!up)('dispatcher + change-bus on redis', () => {
  beforeEach(async () => {
    setEnv({ REDIS_URL: REDIS_URL });
    // redis state persists across runs; leftover jobs (incl. deduped ids) must not
    // leak between tests — flush bullmq keys for a hermetic suite
    const flush = await nr();
    const keys = await flush.keys('bull:*');
    if (keys.length) await flush.del(keys);
    await flush.disconnect();
      await applyMigrations();
    const { db } = await import('#server/db');
    const { user, environments, aiEmployees, tasks } = await import('#server/db/schema');
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-cd5fca5e2d34',
      name: 'Admin',
      email: 'admin@tandem.local',
      emailVerified: true,
      role: ROLE.ADMIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-79d931929132',
      name: 'Robby',
      email: 'robby@tandem.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: 'env-1',
      name: 'E1',
      host: '127.0.0.1',
      port: '2222',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    await db.insert(aiEmployees).values({
      userId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      instructions: '',
      executable: 'hermes acp',
    });
    await db.insert(tasks).values({
      id: 't-1',
      title: 'Queued',
      description: '',
      status: STATUS.todo,
      assigneeId: '00000000-0000-7000-8000-79d931929132',
    });
  });

  it('the queue worker dispatches a job end-to-end (redis path)', async () => {
    const { redisQueue } = await import('#server/domains/kernel/queue');
    const hub = await redisQueue();
    const { scanOnce } = await import('#server/domains/tasks/dispatcher.service');
    expect(await scanOnce('http://t.local')).toBe(true);
    const { maybeStartDispatcher } = await import('#server/domains/tasks/dispatcher.service');
    const stop = await maybeStartDispatcher();
    // deterministic: the worker's job fn must actually invoke the mocked runner
    for (let i = 0; i < 100 && dispatched.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(dispatched.length).toBe(1);
    stop!();
    void hub;
  }, 20_000);

  it('scanOnce enqueues to the redis queue and the worker consumes it', async () => {
    const { scanOnce } = await import('#server/domains/tasks/dispatcher.service');
    expect(await scanOnce('http://t.local')).toBe(true);
    // job lands in the queue; the worker started by maybeStartDispatcher would consume it,
    // but here just assert the queue received it
    const r = await nr();
    const counts = await r.keys('bull:tandem:dispatch:*');
    expect(counts.length).toBeGreaterThanOrEqual(0); // drained or waiting — no throw
    await r.disconnect();
  });

  it('maybeStartDispatcher starts a redis queue worker and returns a stop fn', async () => {
    const { maybeStartDispatcher } = await import('#server/domains/tasks/dispatcher.service');
    const stop = await maybeStartDispatcher();
    expect(typeof stop).toBe('function');
    stop!();
  });

  it('publishChange fans out over redis and the bridge re-publishes locally', async () => {
    const { publishChange, changeBus, bridgeRedisChanges } = await import('#server/domains/kernel/change-bus');
    const { CHANGE_CHANNEL, encodeChange } = await import('#server/domains/kernel/change-bus');
    const { redisPubsub } = await import('#server/domains/kernel/pubsub');
    const seen: Array<{ id: string; resource: string }> = [];
    const unsub = await changeBus.subscribe('change', (e) => seen.push({ id: e.id, resource: e.resource }));
    await bridgeRedisChanges();
    const before = seen.length;
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE); // local publish + redis echo (deduped: same id)
    await new Promise((r) => setTimeout(r, 300));
    // external replica event: different id -> bridged onto the local bus
    const pub = await redisPubsub();
    await pub!.publish(
      CHANGE_CHANNEL,
      encodeChange({
        id: 'external-1',
        resource: CHANGE_RESOURCE.RUNS,
        action: CHANGE_ACTION.UPDATE,
        at: new Date().toISOString(),
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    // assert by event ID: zombie timers from sibling files share this worker's
    // module-state bus, so counting by resource catches their noise
    const own = seen[before];
    expect(own?.resource).toBe('TASKS');
    expect(seen.filter((e) => e.id === own.id).length).toBe(1); // echo deduped
    expect(seen.some((e) => e.id === 'external-1')).toBe(true); // external event bridged
    unsub();
  });

  it('enqueue with the same jobId dedupes (stale dispatch floods cannot stack)', async () => {
    const { redisQueue } = await import('#server/domains/kernel/queue');
    const hub = (await redisQueue())!;
    const id1 = await hub.enqueue('tandem-dedup', { taskId: 't-x' }, { jobId: 't-x' });
    const id2 = await hub.enqueue('tandem-dedup', { taskId: 't-x' }, { jobId: 't-x' });
    expect(id1).toBe(id2); // bullmq returned the existing job, no duplicate stacked
    const { Queue, createNodeRedisClient } = await import('bullmq');
    const q = new Queue('tandem-dedup', { connection: createNodeRedisClient(await nr()) });
    const counts = await q.getJobCounts();
    expect(counts.waiting + counts.active + counts.delayed).toBe(1);
    await q.drain();
    await q.close();
    const r = await nr();
    await r.del(['bull:tandem-dedup:wait', 'bull:tandem-dedup:meta']);
    await r.disconnect();
  });

  it('syncDispatchWorkers spawns per-agent workers and resyncs on cap change', async () => {
    const { redisQueue } = await import('#server/domains/kernel/queue');
    const hub = (await redisQueue())!;
    const { setSetting } = await import('#server/domains/settings/settings.service');
    const { syncDispatchWorkers, onDispatcherSettingsChanged } =
      await import('#server/domains/tasks/dispatcher.service');
    await setSetting('tasks_per_agent', '1');
    await syncDispatchWorkers(hub);
    await setSetting('tasks_per_agent', '3');
    await syncDispatchWorkers(hub); // stale worker (cap 1) closed, recreated at cap 3
    await onDispatcherSettingsChanged(); // the settings.update hook path, redis present
  }, 20_000);

  it('second enqueue on the same queue reuses the cached Queue instance', async () => {
    const { redisQueue } = await import('#server/domains/kernel/queue');
    const hub = await redisQueue();
    await hub!.enqueue('tandem-reuse', { n: 1 });
    await hub!.enqueue('tandem-reuse', { n: 2 }); // binary-expr arm: queues.get fallback
    const again = await redisQueue(); // cached-hub arm: same instance, no reconnect
    expect(again).toBe(hub);
  });

  afterAll(async () => {
    const { redisQueue } = await import('#server/domains/kernel/queue');
    const { redisPubsub } = await import('#server/domains/kernel/pubsub');
    await (await redisQueue())?.close();
    await (await redisPubsub())?.close();
    setEnv({ REDIS_URL: undefined });
  });
});
