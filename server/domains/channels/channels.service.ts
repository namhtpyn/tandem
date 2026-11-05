// Channels core — backend relay (SPEC: Channels, contract v1, #271 slice 1).
// The service owns EVERYTHING except transport: config parse, identity
// binding (default deny), inbound durability (persist → checkpoint → BullMQ →
// idempotent worker + boot sweep), routing verbs (new-task / note / answer)
// through the SAME procs the web composer uses, and instant acks. Adapter
// files never learn Tandem ids; this file never branches on transport.
import { consola } from 'consola';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_ACTION, CHANGE_RESOURCE, CATEGORY, ROLE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { channelEvents, channelOutbox, channelThreads, tasks } from '../../db/schema';
import { env } from '../kernel/env';
import { publishChange } from '../kernel/kernel';
import { redisQueue, type QueueDomain } from '../kernel/queue';
import { getSetting, setSetting } from '../settings/settings.service';
import { recordAssignment } from '../tasks/assignments.service';
import { stripAttachments } from '../tasks/attachments.util';
import { addNote, answerQuestion } from '../tasks/workflow.service';
import { decryptSecret } from '../vault/secret/secret-crypto.service';
import {
  createChannelAdapter,
  registeredChannelKinds,
  type ChannelAdapter,
  type ChannelInboundMessage,
} from './adapter';
import { registerMatrixChannelAdapter } from './matrix.adapter';

// EXPLICIT registry arming (never a bare side-effect import — the bundler
// tree-shakes those out and prod would silently run zero adapters)
registerMatrixChannelAdapter();

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
  // user ids are uuid columns — a non-uuid binding would throw 22P02 on every
  // event and poison the queue, so the parse itself refuses it
  bindings: z.array(z.object({ platformUserId: z.string().min(1), userId: z.string().uuid() })).default([]),
  defaultAssigneeId: z.string().uuid().nullable().default(null),
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
  const seen = new Set<string>();
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
    // canonicalize BEFORE dedupe: trailing slash / case / default port are
    // the same homeserver and must collapse to one adapter
    const cfg = { ...r.data, homeserverUrl: normalizeHomeserver(r.data.homeserverUrl) };
    // duplicate adapter keys would share a checkpoint + event namespace and
    // silently shadow each other — keep the first, refuse the rest loudly
    const key = `${cfg.kind}:${cfg.homeserverUrl}`;
    if (seen.has(key)) {
      log.warn(`channels config entry skipped: duplicate adapter ${key} (one bot per homeserver in slice 1)`);
      continue;
    }
    seen.add(key);
    out.push(cfg);
  }
  return out;
}

/** canonical homeserver URL: lowercase scheme/host, no default port, no
 * trailing slash — so "https://M.example.org/" and "https://m.example.org"
 * are ONE adapter (dedupe key, checkpoint key and event key all agree) */
export function normalizeHomeserver(raw: string): string {
  const u = new URL(raw);
  const port = u.port === '80' || u.port === '443' ? '' : u.port;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port ? `:${port}` : ''}${path}`;
}

/** settings integrity validator for the stored `channels` value: the raw
 * settings row must be a JSON array whose every entry matches the config
 * schema — anything else is corruption by definition (the write path could
 * not have produced it). Consumed by the settings integrity audit. */
export function channelsIntegrityReason(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid JSON';
  }
  if (!Array.isArray(parsed)) return 'expected a JSON array';
  for (const [i, entry] of parsed.entries()) {
    const r = channelConfigSchema.safeParse(entry);
    if (!r.success) return `entry ${i}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`;
  }
  return null;
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
      // postgres text/jsonb reject NUL bytes AND lone surrogate escapes — one
      // crafted message must never wedge the whole channel forever (sanitize,
      // don't skip: the message still routes)
      body: sanitizeText(m.text),
      raw: sanitizeRawJson(m.raw),
    })
    .onConflictDoNothing({ target: [channelEvents.adapter, channelEvents.externalId] })
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
    where: { adapter: { eq: adapterKey(cfg) }, externalId: { eq: m.externalId } },
  });
  if (existing && !existing.processedAt) await requeueEvent(hub, existing.id);
}

/** postgres-safe text: strip NUL bytes and lone surrogates (both are insert
 * errors that would otherwise wedge the channel on one crafted message) */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function sanitizeText(t: string): string {
  return t.replaceAll('\u0000', '').replace(LONE_SURROGATE, '');
}

/** jsonb-safe raw payload: decode, sanitize every string, re-serialize */
function sanitizeRawJson(raw: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return sanitizeText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  try {
    return walk(JSON.parse(JSON.stringify(raw ?? {}))) as Record<string, unknown>;
  } catch {
    return {}; // unserializable payload: keep the row, lose only the raw echo
  }
}

async function requeueEvent(
  hub: QueueDomain,
  eventId: string,
  opts: { delayMs?: number; defer?: number } = {},
): Promise<void> {
  await hub.enqueue(
    CHANNEL_QUEUE,
    { eventId, deferred: opts.defer ?? 0 },
    {
      delayMs: opts.delayMs,
      attempts: QUEUE_ATTEMPTS,
      removeOnComplete: true,
      removeOnFail: true,
      // jobId dedupe: BullMQ refuses a second job with the same id while one
      // is queued/active — a deploy overlap (old instance's in-flight job +
      // new instance's sweep) can never double-route the same event.
      // removeOnFail:true frees the id after terminal failure so the boot
      // sweep can re-drive a permanently failed event. Deferral cycles get a
      // distinct id per attempt (the original may still be active); no ':'
      // (BullMQ rejects 2-segment custom ids).
      jobId: opts.defer ? `${eventId}-d${opts.defer}` : eventId,
      backoff: { type: 'exponential', delay: 3_000 },
    },
  );
}

// ---------- routing (worker body; SPEC: Routing verbs) ----------

type AckOutcome = 'created' | 'steered' | 'dispatched' | 'noted' | 'answered' | 'closed' | 'refused' | 'failed';

/** one platform event → one Tandem verb. Idempotent by processedAt: a retried
 * job (or the boot sweep) never routes twice. Exported for tests. */
const DEFER_RETRY_MS = 300_000; // 5 min between deferral re-drives
const DEFER_MAX = 12; // ~1h of deferrals, then give up loudly (row stays raw)

const CLAIM_TTL_MS = 5 * 60_000; // a claim older than this is stale (crashed worker)

export async function processChannelEvent(data: { eventId: string; deferred?: number }): Promise<void> {
  const ev = await db.query.channelEvents.findFirst({ where: { id: { eq: data.eventId } } });
  if (!ev || ev.processedAt) return; // unknown or already routed
  // CLAIM CAS (durability law, r5): exactly ONE worker owns an event at a
  // time — deferral cycles, the boot sweep and deploy overlap all carry
  // DIFFERENT job ids, so the processedAt check alone could double-route.
  // A stale claim (crashed mid-route) becomes re-claimable after the TTL,
  // which keeps the at-least-once, no-loss promise.
  const claimRows = await db
    .update(channelEvents)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(channelEvents.id, ev.id),
        isNull(channelEvents.processedAt),
        or(isNull(channelEvents.claimedAt), lt(channelEvents.claimedAt, new Date(Date.now() - CLAIM_TTL_MS))),
      ),
    )
    .returning({ id: channelEvents.id });
  if (claimRows.length === 0) return; // another worker owns it (or a recent claim)
  // resolve through the ORIGINATING adapter key — bindings/acks never cross
  // same-kind configs (two matrix homeservers are two independent channels)
  const cfg = parseChannelConfigs(await getSetting(CHANNELS_KEY)).find((c) => adapterKey(c) === ev.adapter);
  // DEFERRAL LAW (no-loss): without an enabled config or a LIVE adapter the
  // event is NOT consumed — the row stays unprocessed and the next sweep (or
  // job retry) re-drives it once the channel is back. Consuming here would
  // destroy user messages on a config typo / failed token, with no ack.
  const deferred = data.deferred ?? 0;
  const defer = async (why: string): Promise<void> => {
    if (deferred >= DEFER_MAX) {
      log.error(`channel event ${ev.id} gave up after ${DEFER_MAX} deferrals (${why}) — raw row kept`);
      return; // never consumed: the next boot sweep starts a fresh cycle
    }
    log.warn(`channel event ${ev.id} deferred (${why}) — retry in ${DEFER_RETRY_MS / 60_000} min`);
    await db.update(channelEvents).set({ claimedAt: null }).where(eq(channelEvents.id, ev.id));
    await requeueEvent(await redisQueue(), ev.id, { delayMs: DEFER_RETRY_MS, defer: deferred + 1 });
  };
  if (!cfg) {
    await defer(`no enabled config for adapter ${ev.adapter}`);
    return;
  }
  const adapter = activeAdapters.get(adapterKey(cfg));
  if (!adapter || (adapter.isLive && !adapter.isLive())) {
    await defer(`adapter ${ev.adapter} is not live`);
    return;
  }
  let outcome: AckOutcome;
  try {
    outcome = await routeEvent(cfg, ev, adapter);
  } catch (e) {
    // release the claim so the job retry can re-claim immediately
    await db
      .update(channelEvents)
      .set({ claimedAt: null })
      .where(and(eq(channelEvents.id, ev.id), isNull(channelEvents.processedAt)))
      .catch(() => {});
    throw e;
  }
  await db.update(channelEvents).set({ processedAt: new Date() }).where(eq(channelEvents.id, ev.id));
  log.info(`channel event ${ev.id} routed: ${outcome}`);
}

async function routeEvent(
  cfg: ChannelConfig,
  ev: { id: string; threadRef: string; sender: string; body: string },
  adapter: ChannelAdapter,
): Promise<AckOutcome> {
  const ack = async (text: string): Promise<void> => {
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
  // composer parity: a blank message is never a verb (tasks.create/norm require
  // 1-char bodies; a whitespace-only platform message must not create an
  // empty-title task or an empty note/answer)
  const text = ev.body.trim();
  if (!text) {
    await ack('Empty message — nothing to do.');
    return 'refused';
  }

  // a stale binding (user deleted) must refuse politely, NOT poison the queue
  // with an FK-violating retry loop (composer parity: requireExistingRefs)
  const boundUser = await db.query.user.findFirst({
    columns: { id: true, role: true },
    where: { id: { eq: userId } },
  });
  if (!boundUser) {
    log.warn(`channel binding ${ev.sender} → ${userId}: user does not exist — refused`);
    await ack('Your account is not available — ask an admin to fix the channel binding.');
    return 'refused';
  }
  // EMPLOYEE-TIER GATE (SPEC: Roles & access): every channel verb is a tasks.*
  // write, so a VIEWER binding must be refused exactly like the oRPC kernel
  // refuses it — the web composer's role gate does not evaporate over chat.
  if (boundUser.role !== ROLE.EMPLOYEE && boundUser.role !== ROLE.ADMIN) {
    await ack('Your account has view-only access — ask an admin to upgrade it.');
    return 'refused';
  }

  const mapping = await db.query.channelThreads.findFirst({
    columns: { taskId: true },
    where: { adapter: { eq: adapterKey(cfg) }, threadRef: { eq: ev.threadRef } },
  });

  // unmapped thread → NEW-TASK (the web composer's create path verbatim)
  if (!mapping) {
    // composer parity: tasks.create defaults to the FIRST status by position
    // (resolveCreatedStatus(null)) — identical pick, never a guess
    const statusRows = await db.query.taskStatuses.findMany({
      columns: { id: true, category: true },
      orderBy: { position: 'asc' },
    });
    const statusRow = statusRows[0];
    const statusId = statusRow?.id;
    if (!statusId) {
      log.error('no task statuses defined — channel new-task refused');
      await ack('Could not create the task (no statuses configured).');
      return 'failed';
    }
    // title = the first non-empty line of the (already non-blank) message
    const title = nonNull(text.split('\n').find((l) => l.trim().length > 0))
      .trim()
      .slice(0, 200);
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
      description: text.slice(0, COMPOSER_BODY_CAP),
      status: statusId,
      assigneeId,
      ownerId: userId,
      createdBy: userId,
    });
    if (assigneeId) await recordAssignment(id, assigneeId, 'created', userId);
    // ack honesty: only a ready-category AI assignee auto-dispatches
    const willDispatch =
      assigneeId !== null &&
      statusRow?.category === CATEGORY.READY &&
      (await db.query.aiEmployees.findFirst({ columns: { userId: true }, where: { userId: { eq: assigneeId } } })) !==
        null;
    // MAPPING ARBITER: two events from the same brand-new thread can process
    // concurrently (worker concurrency 2) — the unique (channel, thread_ref)
    // index decides; the loser removes its fresh unmapped task and routes as
    // a note on the winner's task instead of leaving an orphan on the board.
    const mappingRows = await db
      .insert(channelThreads)
      .values({ channel: cfg.kind, adapter: adapterKey(cfg), threadRef: ev.threadRef, taskId: id })
      .onConflictDoNothing({ target: [channelThreads.adapter, channelThreads.threadRef] })
      .returning({ id: channelThreads.id });
    if (mappingRows.length === 0) {
      log.warn(`new-task race on thread ${ev.threadRef}: another task owns the mapping — routing as note`);
      // delete only a task with NO messages (nothing can reference it yet);
      // a task a worker already picked up stays visible instead of vanishing
      const touched = await db.query.taskMessages.findFirst({
        columns: { id: true },
        where: { taskId: { eq: id } },
      });
      if (!touched) await db.delete(tasks).where(eq(tasks.id, id));
      const winner = await db.query.channelThreads.findFirst({
        columns: { taskId: true },
        where: { adapter: { eq: adapterKey(cfg) }, threadRef: { eq: ev.threadRef } },
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
      `Task ${id} created: ${title}${
        willDispatch
          ? ' — dispatching to the assigned agent.'
          : assigneeId
            ? ' — assigned; it runs once it reaches a ready status.'
            : ' — attach an assignee in Tandem to run it.'
      }`,
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
  const text = ev.body.trim();
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
      await answerQuestion(task.id, userId, text.slice(0, COMPOSER_BODY_CAP));
      await ack('Answer delivered — the agent resumes.');
      return 'answered';
    } catch (e) {
      // not in the question chain / CAS flip lost — never fall back to a note
      // (a note must never stomp an open question)
      log.warn(`channel answer failed on task ${task.id}:`, e);
      // replay after a crash-mid-verb: the question is already resolved —
      // report the truth instead of a false failure
      const nowRows = await db.query.taskStatuses.findMany({
        columns: { id: true, category: true },
        where: {
          id: {
            eq:
              (await db.query.tasks.findFirst({ columns: { status: true }, where: { id: { eq: task.id } } }))?.status ??
              '',
          },
        },
      });
      if (nowRows[0]?.category !== CATEGORY.WAITING_ANSWER) {
        // the question resolved while we routed (settle/CAS race) — the text
        // is still preserved as a note (a note cannot stomp a resolved task)
        await addNote(task.id, userId, text.slice(0, COMPOSER_BODY_CAP));
        await ack('The question was already resolved — your message was added as a note.');
        return 'noted';
      }
      await ack('Could not deliver the answer — answer in the web app.');
      return 'failed';
    }
  }

  // everything else → NOTE through the composer path (steer-live /
  // dispatch-stopped composer law verbatim inside addNote)
  const outcome = await addNote(task.id, userId, text.slice(0, COMPOSER_BODY_CAP));
  await ack(
    outcome.steered
      ? 'Sent to the running agent.'
      : outcome.dispatched
        ? 'Queued — the agent will pick it up.'
        : 'Noted on the task.',
  );
  return outcome.steered ? 'steered' : outcome.dispatched ? 'dispatched' : 'noted';
}

// ---------- reply relay (SPEC: Reply relay, slice 2 — final-only outbound) ----------

const OUTBOX_QUEUE = 'channels-outbound';
const OUTBOX_DEFER_MS = 300_000; // 5 min between adapter-down re-drives (inbound parity)
const OUTBOX_DEFER_MAX = 12; // ~1h, then the row stays raw for the boot sweep
/** per-thread ordering poll: an older reply in the same thread still pending —
 * re-kick with capped growth (NOT the deferral budget: a poll is not a fault) */
const OUTBOX_WAIT_BASE_MS = 2_000;
const OUTBOX_WAIT_MAX_MS = 60_000;

/** channel-visible reply body: the thread turn's text with Tandem-internal
 * attachment tokens reduced to their label (platform-external syntax must
 * never reach the channel) and the inbound sanitizer applied. */
export function relayBodyOf(rawBody: string | null | undefined): string {
  return sanitizeText(stripAttachments((rawBody ?? '').trim()));
}

async function requeueOutbox(
  hub: QueueDomain,
  outboxId: string,
  opts: { delayMs?: number; defer?: number; wait?: number } = {},
): Promise<void> {
  await hub.enqueue(
    OUTBOX_QUEUE,
    { outboxId, deferred: opts.defer ?? 0, wait: opts.wait ?? 0 },
    {
      delayMs: opts.delayMs,
      attempts: QUEUE_ATTEMPTS,
      removeOnComplete: true,
      removeOnFail: true,
      // jobId dedupe (inbound parity): BullMQ refuses a second job with the
      // same id while one is queued/active — deploy overlap can never
      // double-send. Distinct suffix per deferral/wait cycle; no ':' (BullMQ
      // rejects 2-segment custom ids).
      jobId: opts.defer ? `${outboxId}-d${opts.defer}` : opts.wait ? `${outboxId}-w${opts.wait}` : outboxId,
      backoff: { type: 'exponential', delay: 3_000 },
    },
  );
}

/** settle-path hook (BEST-EFFORT — the caller never lets a relay failure fail
 * the settle): persist one outbox row PER channel thread mapped to the task
 * BEFORE any queue job (deploys drop nothing), then kick the outbound queue.
 * The unique (adapter, runId, threadRef) index makes re-drives idempotent.
 * Returns the number of rows enqueued. */
export async function relaySettledRun(taskId: string, runId: string, messageId: string): Promise<number> {
  const mappings = await db.query.channelThreads.findMany({
    columns: { adapter: true, threadRef: true },
    where: { taskId: { eq: taskId } },
  });
  if (mappings.length === 0) return 0;
  const msg = await db.query.taskMessages.findFirst({
    columns: { body: true },
    where: { id: { eq: messageId } },
  });
  // the writer calls this AFTER the body rewrite (envelope text else human
  // tail) — the row already carries the exact text the web thread shows
  const body = relayBodyOf(msg?.body);
  if (!body) return 0; // nothing human-readable to relay (never send an empty reply)
  // PERSIST-ALL-THEN-ENQUEUE (SPEC: never a half-set): every mapping's row is
  // inserted BEFORE the first enqueue — a redis failure mid-relay leaves ALL
  // rows raw for the boot sweep instead of silently dropping later threads
  // (a DONE run settles exactly once, so nothing would ever recreate them)
  const inserted = await db
    .insert(channelOutbox)
    .values(mappings.map((m) => ({ adapter: m.adapter, threadRef: m.threadRef, taskId, runId, body })))
    .onConflictDoNothing({ target: [channelOutbox.adapter, channelOutbox.runId, channelOutbox.threadRef] })
    .returning({ id: channelOutbox.id });
  if (inserted.length === 0) return 0;
  let hub: QueueDomain | null = null;
  let enqueued = 0;
  for (const row of inserted) {
    try {
      // resolve the queue lazily and per-row: a redis blip must not abort the
      // remaining kicks (the un-kicked rows stay raw for the boot sweep)
      hub ??= await redisQueue();
      await requeueOutbox(hub, nonNull(row).id);
      enqueued++;
    } catch (e) {
      log.warn(`channel reply ${row.id} persisted but not enqueued — boot sweep re-drives it:`, e);
    }
  }
  return enqueued;
}

/** outbound worker body: ONE claim CAS per kick, config/adapter resolution
 * through the ORIGINATING adapter key, per-thread ordering (the OLDEST
 * unprocessed row of the conversation sends first), adapter-down deferral
 * (no-loss, inbound parity). Exported for tests. */
export async function processOutboundRow(data: { outboxId: string; deferred?: number; wait?: number }): Promise<void> {
  const row = await db.query.channelOutbox.findFirst({ where: { id: { eq: data.outboxId } } });
  if (!row || row.processedAt) return; // unknown or already sent
  // CLAIM CAS (inbound parity): sweep + deploy overlap + deferral cycles all
  // carry different job ids — the CAS makes exactly one worker own the row.
  const claimRows = await db
    .update(channelOutbox)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(channelOutbox.id, row.id),
        isNull(channelOutbox.processedAt),
        or(isNull(channelOutbox.claimedAt), lt(channelOutbox.claimedAt, new Date(Date.now() - CLAIM_TTL_MS))),
      ),
    )
    .returning({ id: channelOutbox.id });
  if (claimRows.length === 0) return; // another worker owns it
  const deferred = data.deferred ?? 0;
  const releaseClaim = async (): Promise<void> => {
    await db
      .update(channelOutbox)
      .set({ claimedAt: null })
      .where(and(eq(channelOutbox.id, row.id), isNull(channelOutbox.processedAt)));
  };
  const cfg = parseChannelConfigs(await getSetting(CHANNELS_KEY)).find((c) => adapterKey(c) === row.adapter);
  const defer = async (why: string): Promise<void> => {
    if (deferred >= OUTBOX_DEFER_MAX) {
      // release the claim even on give-up: a held claim would stall the whole
      // thread's head gate until the TTL expires (ghost-claim stall, r1 finding)
      await releaseClaim();
      log.error(`channel reply ${row.id} gave up after ${OUTBOX_DEFER_MAX} deferrals (${why}) — raw row kept`);
      return; // never consumed: the next boot sweep starts a fresh cycle
    }
    log.warn(`channel reply ${row.id} deferred (${why}) — retry in ${OUTBOX_DEFER_MS / 60_000} min`);
    await releaseClaim();
    await requeueOutbox(await redisQueue(), row.id, { delayMs: OUTBOX_DEFER_MS, defer: deferred + 1 });
  };
  if (!cfg) {
    await defer(`no enabled config for adapter ${row.adapter}`);
    return;
  }
  const adapter = activeAdapters.get(adapterKey(cfg));
  if (!adapter || (adapter.isLive && !adapter.isLive())) {
    await defer(`adapter ${row.adapter} is not live`);
    return;
  }
  // per-thread ordering: send the OLDEST unprocessed row of this conversation
  // first — a younger row polls (capped growth) until the older one leaves
  const head = await db.query.channelOutbox.findFirst({
    columns: { id: true },
    where: {
      adapter: { eq: row.adapter },
      threadRef: { eq: row.threadRef },
      processedAt: { isNull: true as const },
    },
    orderBy: { createdAt: 'asc', id: 'asc' },
  });
  if (!head || head.id !== row.id) {
    const wait = (data.wait ?? 0) + 1;
    const delay = Math.min(OUTBOX_WAIT_BASE_MS * 2 ** (wait - 1), OUTBOX_WAIT_MAX_MS);
    await releaseClaim();
    log.warn(`channel reply ${row.id} waits for an older reply in thread ${row.threadRef} — re-kick in ${delay}ms`);
    await requeueOutbox(await redisQueue(), row.id, { delayMs: delay, wait });
    return;
  }
  try {
    // pair-aware cap: a raw UTF-16 slice at the boundary can re-create a lone
    // surrogate (invalid JSON escape → homeserver 400 → permanent send
    // failure) — the sanitizer strips whatever the slice splits off
    await adapter.send(row.threadRef, sanitizeText(row.body.slice(0, adapter.capabilities.maxLen)));
  } catch (e) {
    // release the claim so the job retry can re-claim immediately; the row
    // survives (at-least-once) — terminal job failure leaves it raw for sweep
    await releaseClaim().catch(() => {});
    throw e;
  }
  await db.update(channelOutbox).set({ processedAt: new Date() }).where(eq(channelOutbox.id, row.id));
  log.info(`channel reply ${row.id} sent via ${row.adapter} to thread ${row.threadRef}`);
}

// ---------- lifecycle (boot: adapters + workers + sweep) ----------

const activeAdapters = new Map<string, ChannelAdapter>();
let workerHandle: { close: () => Promise<void> } | null = null;
let outboxWorkerHandle: { close: () => Promise<void> } | null = null;

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
 * persist and enqueue) sweep back into the queue. Safe to re-call.
 * ORDER LAW: adapters start BEFORE the sweep — swept events route
 * immediately, and a missing adapter would silently swallow their acks. */
export async function startChannels(): Promise<string[]> {
  // shared test opt-out (TANDEM_NO_DISPATCHER=1): unit/e2e never open
  // adapters or queue workers
  if (env.TANDEM_NO_DISPATCHER) return [];
  const cfgs = parseChannelConfigs(await getSetting(CHANNELS_KEY));
  const hub = await redisQueue();

  // stop adapters whose config disappeared / was disabled / went DEAD
  // (fatal token stop): a dead entry left in the map would defer forever
  const wanted = new Set(cfgs.map(adapterKey));
  for (const [key, adapter] of activeAdapters) {
    if (!wanted.has(key) || (adapter.isLive && !adapter.isLive())) {
      await adapter.stop();
      activeAdapters.delete(key);
    }
  }
  const failed: string[] = [];
  // start (or keep) adapters for enabled configs — a per-adapter failure is
  // logged and skipped, never aborts the rest of the start
  for (const cfg of cfgs) {
    const key = adapterKey(cfg);
    if (activeAdapters.has(key)) continue;
    try {
      const token = await resolveToken(cfg);
      if (!token) {
        failed.push(key); // missing secret — the retry loop re-attempts
        continue;
      }
      const adapter = buildAdapter(cfg, token);
      if (!adapter) {
        failed.push(key);
        continue;
      }
      await adapter.start({
        onMessage: (m) => handleInbound(cfg, m),
        checkpoint: {
          get: () => getSetting(checkpointKey(cfg)),
          set: (v: string) => setSetting(checkpointKey(cfg), v),
        },
      });
      activeAdapters.set(key, adapter);
      log.info(`channel started: ${cfg.kind} @ ${cfg.homeserverUrl} (${cfg.bindings.length} binding(s))`);
    } catch (e) {
      failed.push(key);
      log.error(`channel ${key} failed to start (retry loop will re-attempt):`, e);
    }
  }

  // the worker registers AFTER adapters are live: a swept event must reach a
  // running adapter (a worker-first order would defer every swept event)
  workerHandle ??= await hub.queue(CHANNEL_QUEUE, processChannelEvent, {
    concurrency: 2,
    attempts: QUEUE_ATTEMPTS,
  });
  outboxWorkerHandle ??= await hub.queue(OUTBOX_QUEUE, processOutboundRow, {
    concurrency: 2,
    attempts: QUEUE_ATTEMPTS,
  });
  // boot sweep: every unprocessed event gets a fresh job (idempotent worker +
  // jobId dedupe); its ack reaches a real adapter
  const stranded = await db.query.channelEvents.findMany({
    columns: { id: true },
    where: { processedAt: { isNull: true as const } },
  });
  for (const row of stranded) await requeueEvent(hub, row.id);
  // boot sweep (outbound parity): unsent replies re-enqueue — a deploy crash
  // between relaySettledRun persist and kick drops nothing
  const strandedOutbox = await db.query.channelOutbox.findMany({
    columns: { id: true },
    where: { processedAt: { isNull: true as const } },
  });
  for (const row of strandedOutbox) await requeueOutbox(hub, row.id);
  if (stranded.length > 0 || strandedOutbox.length > 0)
    log.info(`swept ${stranded.length} event(s) + ${strandedOutbox.length} reply(ies) back into the queues`);
  return failed;
}

/** test/ops hook: a manually-built adapter joins the registry (startChannels
 * manages real ones). Returns the key it was filed under. */
export function attachAdapterForTests(key: string, adapter: ChannelAdapter): string {
  activeAdapters.set(key, adapter);
  return key;
}

/** boot retry wrapper (mirror of ensureDispatcherRunning): a failed start —
 * redis blip, db warm-up — retries on a fixed interval instead of staying dead
 * until the next restart. */
export function ensureChannelsRunning(opts: { start: () => Promise<string[]>; intervalMs?: number }): () => void {
  const retryMs = opts.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;
  const attempt = () => {
    if (done) return;
    void opts
      .start()
      .then((failed) => {
        // PARTIAL-START LAW: a resolved call with failed adapters is NOT
        // success — those channels must keep retrying (r5 finding)
        if (failed.length === 0) {
          done = true;
          if (timer) clearInterval(timer);
        } else {
          log.warn(`channels: ${failed.length} adapter(s) not live — retrying every ${retryMs / 1000}s`);
        }
      })
      .catch((e) => log.error('channels: start attempt failed — retrying:', e));
  };
  timer = setInterval(attempt, retryMs);
  attempt();
  return () => {
    if (timer) clearInterval(timer);
  };
}

export async function stopChannels(): Promise<void> {
  for (const [key, adapter] of activeAdapters) {
    await adapter.stop();
    activeAdapters.delete(key);
  }
  await workerHandle?.close();
  workerHandle = null;
  await outboxWorkerHandle?.close();
  outboxWorkerHandle = null;
}
