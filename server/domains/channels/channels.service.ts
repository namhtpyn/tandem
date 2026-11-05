// Channels core — backend relay (SPEC: Channels, contract v1, #271 slice 1).
// The service owns EVERYTHING except transport: config parse, identity
// binding (default deny), inbound durability (persist → checkpoint → BullMQ →
// idempotent worker + boot sweep), routing verbs (new-task / note / answer)
// through the SAME procs the web composer uses, and instant acks. Adapter
// files never learn Tandem ids; this file never branches on transport.
import { consola } from 'consola';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_ACTION, CHANGE_RESOURCE, CATEGORY } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { channelEvents, channelThreads, tasks } from '../../db/schema';
import { env } from '../kernel/env';
import { publishChange } from '../kernel/kernel';
import { redisQueue, type QueueDomain } from '../kernel/queue';
import { getSetting, setSetting } from '../settings/settings.service';
import { recordAssignment } from '../tasks/assignments.service';
import { addNote, answerQuestion } from '../tasks/workflow.service';
import { decryptSecret } from '../vault/secret/secret-crypto.service';
import {
  createChannelAdapter,
  registeredChannelKinds,
  type ChannelAdapter,
  type ChannelInboundMessage,
} from './adapter';
// side-effect import: arms the 'matrix' factory in the adapter registry
import './matrix.adapter';

const log = consola.withTag('channels');

const CHANNELS_KEY = 'channels';
const CHANNEL_QUEUE = 'channels-inbound';
const QUEUE_ATTEMPTS = 5;
/** composer parity cap (tasks.create/answer: z.string().max(10_000)) */
const COMPOSER_BODY_CAP = 10_000;

// ---------- config (settings key `channels`, SPEC: Channel config) ----------

export const channelConfigSchema = z.object({
  kind: z.string().min(1), // validated against the adapter REGISTRY at parse
  enabled: z.boolean(),
  homeserverUrl: z.string().url(),
  tokenSecretId: z.string().min(1),
  bindings: z.array(z.object({ platformUserId: z.string().min(1), userId: z.string().min(1) })).default([]),
  defaultAssigneeId: z.string().min(1).nullable().default(null),
});

export type ChannelConfig = z.infer<typeof channelConfigSchema>;

/** tolerant parse (SPEC: fail closed): a corrupt value reads as no channels;
 * invalid entries are skipped and logged, valid ones survive. */
export function parseChannelConfigs(raw: string | null): ChannelConfig[] {
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error('channels config is corrupt JSON — reading as no channels');
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.error('channels config is not an array — reading as no channels');
    return [];
  }
  const out: ChannelConfig[] = [];
  for (const entry of parsed) {
    const r = channelConfigSchema.safeParse(entry);
    if (!r.success) {
      log.warn(
        `channels config entry skipped: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      continue;
    }
    if (!r.data.enabled) continue; // parse returns ENABLED configs only (SPEC)
    if (!registeredChannelKinds().includes(r.data.kind)) {
      log.warn(`channels config entry skipped: kind ${r.data.kind} has no registered adapter`);
      continue;
    }
    out.push(r.data);
  }
  return out;
}

/** identity binding (SPEC: default deny) — a platform id acts AS a Tandem
 * user ONLY via an explicit binding; everyone else is refused. */
export function resolveBinding(cfg: ChannelConfig, platformUserId: string): string | null {
  return cfg.bindings.find((b) => b.platformUserId === platformUserId)?.userId ?? null;
}

function adapterKey(cfg: ChannelConfig): string {
  return `${cfg.kind}:${cfg.homeserverUrl}`;
}

function checkpointKey(cfg: ChannelConfig): string {
  return `channels:checkpoint:${cfg.kind}:${encodeURIComponent(cfg.homeserverUrl)}`;
}

// ---------- inbound durability (persist → checkpoint → queue) ----------

/** the adapter sink: persist the raw event FIRST (replay-safe dedupe, keyed
 * to the ORIGINATING adapter), then enqueue the processing job. Throws on
 * db outage — the adapter retries the batch from its unchanged checkpoint. */
export async function handleInbound(cfg: ChannelConfig, m: ChannelInboundMessage): Promise<void> {
  const inserted = await db
    .insert(channelEvents)
    .values({
      channel: cfg.kind,
      adapter: adapterKey(cfg),
      externalId: m.externalId,
      threadRef: m.threadRef,
      sender: m.senderPlatformId,
      body: m.text,
      raw: (m.raw ?? {}) as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [channelEvents.channel, channelEvents.externalId] })
    .returning({ id: channelEvents.id });
  const hub = await redisQueue();
  if (inserted.length > 0) {
    await requeueEvent(hub, nonNull(inserted[0]).id);
    return;
  }
  // CONFLICT RECOVERY (batch-retry / lost-enqueue path): the row exists but
  // has no job behind it (persisted, enqueue failed, checkpoint rewound) —
  // re-enqueue; the processedAt guard makes the worker a no-op if a job is
  // already in flight or done.
  const existing = await db.query.channelEvents.findFirst({
    columns: { id: true, processedAt: true },
    where: { channel: { eq: cfg.kind }, externalId: { eq: m.externalId } },
  });
  if (existing && !existing.processedAt) await requeueEvent(hub, existing.id);
}

async function requeueEvent(hub: QueueDomain, eventId: string): Promise<void> {
  await hub.enqueue(
    CHANNEL_QUEUE,
    { eventId },
    { attempts: QUEUE_ATTEMPTS, removeOnComplete: true, backoff: { type: 'exponential', delay: 3_000 } },
  );
}

// ---------- routing (worker body; SPEC: Routing verbs) ----------

type AckOutcome = 'created' | 'steered' | 'dispatched' | 'noted' | 'answered' | 'closed' | 'refused' | 'failed';

/** one platform event → one Tandem verb. Idempotent by processedAt: a retried
 * job (or the boot sweep) never routes twice. Exported for tests. */
export async function processChannelEvent(data: { eventId: string }): Promise<void> {
  const ev = await db.query.channelEvents.findFirst({ where: { id: { eq: data.eventId } } });
  if (!ev || ev.processedAt) return; // unknown or already routed
  // resolve through the ORIGINATING adapter key — bindings/acks never cross
  // same-kind configs (two matrix homeservers are two independent channels)
  const cfg = parseChannelConfigs(await getSetting(CHANNELS_KEY)).find((c) => adapterKey(c) === ev.adapter);
  let outcome: AckOutcome;
  if (!cfg) {
    log.warn(`channel event ${ev.id} dropped: no enabled config for adapter ${ev.adapter}`);
    outcome = 'refused';
  } else {
    outcome = await routeEvent(cfg, ev);
  }
  await db.update(channelEvents).set({ processedAt: new Date() }).where(eq(channelEvents.id, ev.id));
  log.info(`channel event ${ev.id} routed: ${outcome}`);
}

async function routeEvent(
  cfg: ChannelConfig,
  ev: { id: string; threadRef: string; sender: string; body: string },
): Promise<AckOutcome> {
  const adapter = activeAdapters.get(adapterKey(cfg));
  const ack = async (text: string): Promise<void> => {
    if (!adapter) return; // acks are best-effort; routing outcomes are logged
    try {
      await adapter.send(ev.threadRef, text);
    } catch (e) {
      log.warn(`ack send failed on ${cfg.kind} thread ${ev.threadRef}:`, e);
    }
  };

  // identity binding: default deny (SPEC)
  const userId = resolveBinding(cfg, ev.sender);
  if (!userId) {
    await ack('You are not authorized to use this channel.');
    return 'refused';
  }
  // a stale binding (user deleted) must refuse politely, NOT poison the queue
  // with an FK-violating retry loop (composer parity: requireExistingRefs)
  const boundUser = await db.query.user.findFirst({ columns: { id: true }, where: { id: { eq: userId } } });
  if (!boundUser) {
    log.warn(`channel binding ${ev.sender} → ${userId}: user does not exist — refused`);
    await ack('Your account is not available — ask an admin to fix the channel binding.');
    return 'refused';
  }

  const mapping = await db.query.channelThreads.findFirst({
    columns: { taskId: true },
    where: { channel: { eq: cfg.kind }, threadRef: { eq: ev.threadRef } },
  });

  // unmapped thread → NEW-TASK (the web composer's create path verbatim)
  if (!mapping) {
    const statusRows = await db.query.taskStatuses.findMany({ columns: { id: true }, orderBy: { position: 'asc' } });
    const statusId = statusRows[0]?.id;
    if (!statusId) {
      log.error('no task statuses defined — channel new-task refused');
      await ack('Could not create the task (no statuses configured).');
      return 'failed';
    }
    const title = nonNull(ev.body.split('\n', 1)[0]).slice(0, 200);
    const id = uuidv7();
    let assigneeId: string | null = null;
    if (cfg.defaultAssigneeId) {
      const emp = await db.query.user.findFirst({
        columns: { id: true },
        where: { id: { eq: cfg.defaultAssigneeId } },
      });
      if (emp) assigneeId = cfg.defaultAssigneeId;
      else log.warn(`channel defaultAssigneeId ${cfg.defaultAssigneeId} does not exist — task created unassigned`);
    }
    await db.insert(tasks).values({
      id,
      title,
      description: ev.body.slice(0, COMPOSER_BODY_CAP),
      status: statusId,
      assigneeId,
      ownerId: userId,
      createdBy: userId,
    });
    if (assigneeId) await recordAssignment(id, assigneeId, 'created', userId);
    // MAPPING ARBITER: two events from the same brand-new thread can process
    // concurrently (worker concurrency 2) — the unique (channel, thread_ref)
    // index decides; the loser removes its fresh unmapped task and routes as
    // a note on the winner's task instead of leaving an orphan on the board.
    const mappingRows = await db
      .insert(channelThreads)
      .values({ channel: cfg.kind, threadRef: ev.threadRef, taskId: id })
      .onConflictDoNothing({ target: [channelThreads.channel, channelThreads.threadRef] })
      .returning({ id: channelThreads.id });
    if (mappingRows.length === 0) {
      log.warn(`new-task race on thread ${ev.threadRef}: another task owns the mapping — routing as note`);
      await db.delete(tasks).where(eq(tasks.id, id));
      const winner = await db.query.channelThreads.findFirst({
        columns: { taskId: true },
        where: { channel: { eq: cfg.kind }, threadRef: { eq: ev.threadRef } },
      });
      if (!winner) {
        await ack('Could not create the task — try again.');
        return 'failed';
      }
      return routeMapped(cfg, ev, userId, ack, winner.taskId);
    }
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.CREATE);
    await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
    await ack(
      `Task ${id} created: ${title}${assigneeId ? ' — dispatching to the assigned agent.' : ' — attach an assignee in Tandem to run it.'}`,
    );
    return 'created';
  }

  return routeMapped(cfg, ev, userId, ack, mapping.taskId);
}

/** mapped-thread verbs: closed / answer / note (verb pick keys off status
 * CATEGORY, never seeded ids — #265 law) */
async function routeMapped(
  cfg: ChannelConfig,
  ev: { threadRef: string; body: string },
  userId: string,
  ack: (text: string) => Promise<void>,
  taskId: string,
): Promise<AckOutcome> {
  const task = await db.query.tasks.findFirst({
    columns: { id: true, status: true },
    where: { id: { eq: taskId } },
  });
  if (!task) {
    // FK cascade means this cannot happen (mapping dies with its task) — a
    // defensive refusal keeps the worker total anyway
    await ack('The mapped task no longer exists — start a new task in this channel.');
    return 'refused';
  }

  // verb pick keys off status CATEGORY, never seeded ids (#265 law)
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    where: { id: { eq: task.status } },
  });
  const category = statusRows.find((r) => r.id === task.status)?.category;

  if (category === CATEGORY.DONE || category === CATEGORY.CANCELLED) {
    await ack('This task is closed — start a new task in this channel to open a fresh one.');
    return 'closed';
  }
  if (category === CATEGORY.WAITING_ANSWER) {
    try {
      await answerQuestion(task.id, userId, ev.body.slice(0, COMPOSER_BODY_CAP));
      await ack('Answer delivered — the agent resumes.');
      return 'answered';
    } catch (e) {
      // not in the question chain / CAS flip lost — never fall back to a note
      // (a note must never stomp an open question)
      log.warn(`channel answer failed on task ${task.id}:`, e);
      await ack('Could not deliver the answer — answer in the web app.');
      return 'failed';
    }
  }

  // everything else → NOTE through the composer path (steer-live /
  // dispatch-stopped composer law verbatim inside addNote)
  const outcome = await addNote(task.id, userId, ev.body.slice(0, COMPOSER_BODY_CAP));
  await ack(
    outcome.steered
      ? 'Sent to the running agent.'
      : outcome.dispatched
        ? 'Queued — the agent will pick it up.'
        : 'Noted on the task.',
  );
  return outcome.steered ? 'steered' : outcome.dispatched ? 'dispatched' : 'noted';
}

// ---------- lifecycle (boot: adapters + worker + sweep) ----------

const activeAdapters = new Map<string, ChannelAdapter>();
let workerHandle: { close: () => Promise<void> } | null = null;

async function resolveToken(cfg: ChannelConfig): Promise<string | null> {
  const row = await db.query.vaultSecrets.findFirst({
    columns: { ciphertext: true },
    where: { id: { eq: cfg.tokenSecretId } },
  });
  if (!row) {
    log.warn(
      `channel ${cfg.kind}:${cfg.homeserverUrl}: token secret ${cfg.tokenSecretId} not found — channel not started`,
    );
    return null;
  }
  return decryptSecret(row.ciphertext);
}

function buildAdapter(cfg: ChannelConfig, token: string): ChannelAdapter | null {
  // registry lookup — the core never branches on kind (SPEC: one adapter
  // file per channel; the config parse already dropped unknown kinds)
  return createChannelAdapter(cfg.kind, { homeserverUrl: cfg.homeserverUrl, token });
}

/** start channels: enabled configs get adapters, the worker registers, and
 * stranded rows (persisted but never enqueued — e.g. a deploy crash between
 * persist and enqueue) sweep back into the queue. Safe to re-call. */
export async function startChannels(): Promise<void> {
  // shared test opt-out (TANDEM_NO_DISPATCHER=1): unit/e2e never open
  // adapters or queue workers
  if (env.TANDEM_NO_DISPATCHER) return;
  const cfgs = parseChannelConfigs(await getSetting(CHANNELS_KEY));
  const hub = await redisQueue();
  workerHandle ??= await hub.queue(CHANNEL_QUEUE, processChannelEvent, {
    concurrency: 2,
    attempts: QUEUE_ATTEMPTS,
  });
  // boot sweep: every unprocessed event gets a fresh job (idempotent worker)
  const stranded = await db.query.channelEvents.findMany({
    columns: { id: true },
    where: { processedAt: { isNull: true as const } },
  });
  for (const row of stranded) await requeueEvent(hub, row.id);
  if (stranded.length > 0) log.info(`swept ${stranded.length} stranded channel event(s) back into the queue`);

  // stop adapters whose config disappeared / was disabled
  const wanted = new Set(cfgs.map(adapterKey));
  for (const [key, adapter] of activeAdapters) {
    if (!wanted.has(key)) {
      await adapter.stop();
      activeAdapters.delete(key);
    }
  }
  // start (or keep) adapters for enabled configs
  for (const cfg of cfgs) {
    const key = adapterKey(cfg);
    if (activeAdapters.has(key)) continue;
    const token = await resolveToken(cfg);
    if (!token) continue;
    const adapter = buildAdapter(cfg, token);
    if (!adapter) continue;
    await adapter.start({
      onMessage: (m) => handleInbound(cfg, m),
      checkpoint: {
        get: () => getSetting(checkpointKey(cfg)),
        set: (v: string) => setSetting(checkpointKey(cfg), v),
      },
    });
    activeAdapters.set(key, adapter);
    log.info(`channel started: ${cfg.kind} @ ${cfg.homeserverUrl} (${cfg.bindings.length} binding(s))`);
  }
}

/** test/ops hook: a manually-built adapter joins the registry (startChannels
 * manages real ones). Returns the key it was filed under. */
export function attachAdapterForTests(key: string, adapter: ChannelAdapter): string {
  activeAdapters.set(key, adapter);
  return key;
}

export async function stopChannels(): Promise<void> {
  for (const [key, adapter] of activeAdapters) {
    await adapter.stop();
    activeAdapters.delete(key);
  }
  await workerHandle?.close();
  workerHandle = null;
}
