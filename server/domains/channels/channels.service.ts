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
import { storableId } from '#shared/utils/storable-text';

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

export const CHANNELS_KEY = 'channels';
const CHANNEL_QUEUE = 'channels-inbound';
const QUEUE_ATTEMPTS = 5;
/** composer parity cap (tasks.create/answer: z.string().max(10_000)) */
const COMPOSER_BODY_CAP = 10_000;

// ---------- config (settings key `channels`, SPEC: Channel config) ----------

export const channelConfigSchema = z.object({
  kind: z.string().min(1), // validated against the adapter REGISTRY at parse
  enabled: z.boolean(),
  homeserverUrl: z.string().url(),
  tokenSecretId: storableId('tokenSecretId'),
  // user ids are uuid columns — a non-uuid binding would throw 22P02 on every
  // event and poison the queue, so the parse itself refuses it
  bindings: z.array(z.object({ platformUserId: z.string().min(1), userId: z.string().uuid() })).default([]),
  defaultAssigneeId: z.string().uuid().nullable().default(null),
});

export type ChannelConfig = z.infer<typeof channelConfigSchema>;

/** the ADMIN write schema: same shape, but unknown keys refused at EVERY
 * nesting level (API law: strict admin input; the runtime parser stays
 * tolerant-strip for hand-edited values). Derived from the runtime schema's
 * own shape so the two cannot drift. */
export const adminChannelConfigSchema = z.strictObject({
  ...channelConfigSchema.shape,
  bindings: z.array(z.strictObject(channelConfigSchema.shape.bindings.unwrap().element.shape)),
});

export type ChannelEntryDiagnostic = {
  /** the raw stored entry (unknown JSON — the UI shows what was stored) */
  raw: unknown;
  /** 'ok' = the runtime parser accepts this entry; 'dropped' = refused */
  status: 'ok' | 'dropped';
  /** drop reason (empty for ok entries) */
  reason: string;
  /** canonicalized config when parseable (schema-valid), else null */
  cfg: ChannelConfig | null;
};

export type ChannelConfigInspection = {
  entries: ChannelEntryDiagnostic[];
  /** non-null when the raw value could not be an entry list at all */
  corrupt: string | null;
};

/** per-entry inspection — the SINGLE source of truth shared by the runtime
 * parser (tolerant skip) and the admin write path (strict refuse), so the two
 * can never drift (SPEC: Channel settings UI). Validation pipeline mirrors
 * parseChannelConfigs exactly: schema → registered kind → canonicalize →
 * dedupe (enabled entries only join the seen-set — a disabled duplicate never
 * shadows an enabled one, runtime parity). */
export function inspectChannelConfigs(raw: string | null): ChannelConfigInspection {
  if (raw === null || raw.trim() === '') return { entries: [], corrupt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], corrupt: 'config is corrupt JSON — reading as no channels' };
  }
  if (!Array.isArray(parsed)) return { entries: [], corrupt: 'config is not an array — reading as no channels' };
  const entries: ChannelEntryDiagnostic[] = [];
  const seen = new Set<string>();
  const seenContent = new Set<string>();
  for (const entry of parsed) {
    const r = channelConfigSchema.safeParse(entry);
    if (!r.success) {
      entries.push({
        raw: entry,
        status: 'dropped',
        reason: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        cfg: null,
      });
      continue;
    }
    if (!registeredChannelKinds().includes(r.data.kind)) {
      entries.push({
        raw: entry,
        status: 'dropped',
        reason: `kind ${r.data.kind} has no registered adapter`,
        cfg: null,
      });
      continue;
    }
    // canonicalize BEFORE dedupe: trailing slash / case / default port are
    // the same homeserver and must collapse to one adapter
    const cfg = { ...r.data, homeserverUrl: normalizeHomeserver(r.data.homeserverUrl) };
    // EXACT-content duplicates: byte-identical after canonicalization = ONE
    // channel — keep the first, drop the rest. Row ops that target "the row
    // with this exact content" (the settings card's fingerprint identity)
    // must stay unambiguous: two identical rows collided fingerprints and
    // delete-one removed both (r5 review)
    const contentKey = JSON.stringify(cfg);
    if (seenContent.has(contentKey)) {
      entries.push({ raw: entry, status: 'dropped', reason: 'exact duplicate of a previous entry', cfg });
      continue;
    }
    seenContent.add(contentKey);
    // duplicate adapter keys would share a checkpoint + event namespace and
    // silently shadow each other — keep the first, refuse the rest loudly
    const key = `${cfg.kind}:${cfg.homeserverUrl}`;
    if (cfg.enabled && seen.has(key)) {
      entries.push({
        raw: entry,
        status: 'dropped',
        reason: `duplicate adapter ${key} (one bot per homeserver in slice 1)`,
        cfg,
      });
      continue;
    }
    entries.push({ raw: entry, status: 'ok', reason: '', cfg });
    if (cfg.enabled) seen.add(key);
  }
  return { entries, corrupt: null };
}

/** tolerant parse (SPEC: fail closed): a corrupt value reads as no channels;
 * invalid entries are skipped and logged, valid ones survive. Derived from
 * inspectChannelConfigs — the admin path refuses what this skips. */
export function parseChannelConfigs(raw: string | null): ChannelConfig[] {
  const insp = inspectChannelConfigs(raw);
  if (insp.corrupt) log.error(`channels ${insp.corrupt}`);
  for (const e of insp.entries) {
    if (e.status === 'dropped') log.warn(`channels config entry skipped: ${e.reason}`);
  }
  return insp.entries.flatMap((e) => (e.status === 'ok' && e.cfg?.enabled && e.cfg ? [e.cfg] : []));
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

export function adapterKey(cfg: ChannelConfig): string {
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
  opts: { delayMs?: number; defer?: number; wait?: number; claims?: number } = {},
): Promise<void> {
  await hub.enqueue(
    OUTBOX_QUEUE,
    { outboxId, deferred: opts.defer ?? 0, wait: opts.wait ?? 0, claims: opts.claims ?? 0 },
    {
      delayMs: opts.delayMs,
      attempts: QUEUE_ATTEMPTS,
      removeOnComplete: true,
      removeOnFail: true,
      // jobId dedupe (inbound parity): BullMQ refuses a second job with the
      // same id while one is queued/active — deploy overlap can never
      // double-send. Distinct suffix per cycle; no ':' (BullMQ rejects
      // 2-segment custom ids).
      jobId: opts.defer
        ? `${outboxId}-d${opts.defer}`
        : opts.wait
          ? `${outboxId}-w${opts.wait}`
          : opts.claims
            ? `${outboxId}-c${opts.claims}`
            : outboxId,
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
  if (!body) {
    // honest skip (never an empty message): a turn whose body reduces to
    // empty (e.g. only unlabeled attachment tokens) relays nothing
    log.info(`channel reply for run ${runId} skipped: the turn body reduces to empty`);
    return 0;
  }
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
export async function processOutboundRow(data: {
  outboxId: string;
  deferred?: number;
  wait?: number;
  claims?: number;
}): Promise<void> {
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
  if (claimRows.length === 0) {
    // CAS LOST — two cases: another LIVE worker owns it (racing), or a worker
    // was KILLED mid-send leaving a fresh claim (the r3 root: a silent return
    // here would remove the job and orphan a claimed-jobless row until the
    // NEXT boot). Re-kick after the claim TTL (bounded) so an unprocessed row
    // always has a pending job; the winner's processed write makes those
    // re-kicks no-ops.
    const claims = (data.claims ?? 0) + 1;
    if (claims > 3) return; // give up loudly enough: the boot sweep re-drives
    await requeueOutbox(await redisQueue(), row.id, { delayMs: CLAIM_TTL_MS, claims });
    return;
  }
  const deferred = data.deferred ?? 0;
  const releaseClaim = async (): Promise<void> => {
    await db
      .update(channelOutbox)
      .set({ claimedAt: null })
      .where(and(eq(channelOutbox.id, row.id), isNull(channelOutbox.processedAt)));
  };
  // POST-CLAIM GUARD (inbound parity): EVERY failure after the claim — the
  // config read, the head query, the send, the processed write — must release
  // the claim before rethrowing, or BullMQ's quick retries (all inside the
  // 5-min claim TTL) would no-op on the CAS and orphan the row jobless until
  // the next boot sweep, silently stalling the whole thread behind it.
  try {
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
    // pair-aware cap: a raw UTF-16 slice at the boundary can re-create a lone
    // surrogate (invalid JSON escape → homeserver 400 → permanent send
    // failure) — the sanitizer strips whatever the slice splits off
    await adapter.send(row.threadRef, sanitizeText(row.body.slice(0, adapter.capabilities.maxLen)));
    await db.update(channelOutbox).set({ processedAt: new Date() }).where(eq(channelOutbox.id, row.id));
  } catch (e) {
    // release the claim so the job retry can re-claim immediately; the row
    // survives (at-least-once) — terminal job failure leaves it raw for sweep
    await releaseClaim().catch(() => {});
    throw e;
  }
  log.info(`channel reply ${row.id} sent via ${row.adapter} to thread ${row.threadRef}`);
}

// ---------- watchdog health (slice 3: per-channel liveness stamps) ----------

/** watchdog stamp key (#271 slice 3): JSON {stampedAt, channels:[{key, kind,
 * homeserverUrl, connected, lastSyncOkAt}]} — the external prod probe alerts
 * stamp-stale (tick dead), connected:false (adapter down/dead-token) and
 * transport-stale (sync loop alive, homeserver unreachable; capable+null with
 * healthOk:true = never-synced). ABSENT key (pre-slice image, or no boot
 * start ever completed) stays silent. Queue depth is deliberately NOT
 * stamped — DB-derivable (SPEC: Watchdog health). */
export const CHANNELS_HEALTH_KEY = 'channels:health';
const HEALTH_TICK_MS = 60_000;
let healthTimer: ReturnType<typeof setInterval> | null = null;

/** per-config stamp entry: liveness + health reads are isolated PER READ — a
 * throwing isLive degrades to connected:false, a throwing health to
 * healthOk:false (a failed read must not fabricate the never-synced shape:
 * capable + healthOk:true + null is the alertable never-synced signature). */
function healthEntryFor(cfg: ChannelConfig): Record<string, unknown> {
  const key = adapterKey(cfg);
  const adapter = activeAdapters.get(key);
  let connected = false;
  try {
    connected = !!adapter && (!adapter.isLive || adapter.isLive());
  } catch {
    // connected stays false (the conservative liveness signal)
  }
  // healthOk means "a health() read HAPPENED and succeeded" — a missing
  // adapter or a missing health() is NOT a successful read (no read exists),
  // so it stays false there, consistent with parse-dropped entries
  const healthFn = adapter?.health;
  const healthCap = typeof healthFn === 'function';
  let lastSyncOkAt: number | null = null;
  let healthOk = false;
  if (healthFn) {
    try {
      lastSyncOkAt = healthFn().lastSyncOkAt ?? null;
      healthOk = true;
    } catch {
      // lastSyncOkAt stays null + healthOk:false — telemetry fault, not absence
    }
  }
  return {
    key,
    kind: cfg.kind,
    homeserverUrl: cfg.homeserverUrl,
    connected,
    // healthCap separates "adapter has no health() (null = not alertable)"
    // from "health() present" — the null's alertability then rides healthOk
    healthCap,
    healthOk,
    lastSyncOkAt,
  };
}

/** PARSE-DROPPED COVERAGE (SPEC: one entry per ENABLED config): an enabled
 * entry the parser dropped (unknown/unregistered kind, invalid shape) is
 * otherwise invisible to every alarm channel — no adapter, no retry loop,
 * integrity audit passes — so stamp it connected:false instead. */
function parseDroppedEntries(raw: string | null, known: Set<string>): Array<Record<string, unknown>> {
  const dropped: Array<Record<string, unknown>> = [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw ?? '[]');
  } catch {
    return dropped; // raw corrupt → the parser already read it as no channels
  }
  if (!Array.isArray(arr)) return dropped;
  for (const e of arr) {
    if (!e || typeof e !== 'object' || (e as { enabled?: unknown }).enabled !== true) continue;
    const cand = e as { kind?: unknown; homeserverUrl?: unknown };
    const kind = typeof cand.kind === 'string' && cand.kind ? cand.kind : 'unknown';
    // CANONICAL-KEY LAW: `known` holds keys over the CANONICALIZED config
    // (parseChannelConfigs normalizeHomeservers before dedupe) — a kept
    // config stored under a non-canonical spelling (trailing slash, :443,
    // uppercase host) must match its own canonical key here, or every stamp
    // grows a phantom connected:false entry for a HEALTHY channel
    let home = 'unknown';
    if (typeof cand.homeserverUrl === 'string' && cand.homeserverUrl) {
      try {
        home = normalizeHomeserver(cand.homeserverUrl);
      } catch {
        home = cand.homeserverUrl; // not a parseable URL — the raw spelling
      }
    }
    const key = `${kind}:${home}`;
    if (known.has(key)) continue;
    known.add(key);
    dropped.push({
      key,
      kind,
      homeserverUrl: home,
      connected: false,
      healthCap: false,
      healthOk: false,
      lastSyncOkAt: null,
    });
  }
  return dropped;
}

/** one stamp write (exported for tests): best-effort — its own catch, same
 * law as the dispatcher heartbeat. An entry exists per ENABLED config whether
 * or not its adapter started (a failed-to-start adapter reports
 * connected:false — that IS the signal); zero configs stamp an empty array. */
export async function writeChannelHealthStamp(): Promise<void> {
  try {
    const raw = await getSetting(CHANNELS_KEY);
    const channels: Array<Record<string, unknown>> = parseChannelConfigs(raw).map(healthEntryFor);
    const known = new Set<string>(channels.map((c) => c.key as string));
    channels.push(...parseDroppedEntries(raw, known));
    await setSetting(CHANNELS_HEALTH_KEY, JSON.stringify({ stampedAt: Date.now(), channels }));
  } catch {
    // health is best-effort: observability must never crash the tick
  }
}

// ---------- lifecycle (boot: adapters + workers + sweep) ----------

const activeAdapters = new Map<string, ChannelAdapter>();
/** the config each running adapter was STARTED with (JSON) — a stored-config
 * edit under the same key means the running adapter is stale and restarts */
const activeConfigs = new Map<string, string>();
let workerHandle: { close: () => Promise<void> } | null = null;
let outboxWorkerHandle: { close: () => Promise<void> } | null = null;
// the boot sweep runs ONCE per process (r4 finding): the 30s partial-start
// retry loop must not re-sweep — a fresh re-kick with a reset budget every
// 30s would make the deferral give-up bound unreachable and churn the queue
// forever while an adapter is down. A restart re-sweeps (that's the point).
let sweptThisProcess = false;

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
  // serialized: the retry loop and the settings-change re-arm can both fire a
  // start — two concurrent starts would double-start an adapter (two sync
  // loops racing one checkpoint). The chain swallows rejections: one failed
  // start must not poison the next caller's start.
  const p = startChain.then(() => startChannelsInner());
  startChain = p.catch(() => [] as string[]);
  return p;
}
let startChain: Promise<string[]> = Promise.resolve([]);

/** whether a running adapter must stop against the parsed configs: removed /
 * disabled / CHANGED under its key (running adapters capture their start-time
 * config — stale fingerprints restart) / dead (fatal token stop) */
function adapterMustStop(key: string, cfgs: ChannelConfig[], adapter: ChannelAdapter): boolean {
  const cfg = cfgs.find((c) => adapterKey(c) === key);
  if (cfg === undefined || activeConfigs.get(key) !== JSON.stringify(cfg)) return true;
  return !!(adapter.isLive && !adapter.isLive());
}

async function startChannelsInner(): Promise<string[]> {
  // shared test opt-out (TANDEM_NO_DISPATCHER=1): unit/e2e never open
  // adapters or queue workers
  if (env.TANDEM_NO_DISPATCHER) return [];
  // NOTE: a DIRECT startChannels() after an explicit stopChannels is a
  // deliberate restart (stop/start cycle law — re-sweeps). The STOPPED
  // invariant protects only against the settings hook resurrecting the module.
  const cfgs = parseChannelConfigs(await getSetting(CHANNELS_KEY));
  const hub = await redisQueue();

  // stop adapters whose config disappeared / was disabled / CHANGED / went
  // DEAD: a dead entry left in the map would defer forever; a config edit
  // under an unchanged key must restart the adapter too — the running adapter
  // captured the OLD config (e.g. old token) in its start closure, and the
  // runtime runs what is STORED, not what was started
  for (const [key, adapter] of activeAdapters) {
    if (adapterMustStop(key, cfgs, adapter)) {
      await adapter.stop();
      activeAdapters.delete(key);
      activeConfigs.delete(key);
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
      activeConfigs.set(key, JSON.stringify(cfg));
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
  // jobId dedupe); its ack reaches a real adapter. ONCE PER PROCESS: the
  // partial-start retry loop must not re-sweep (fresh budgets + churn), a
  // restart re-sweeps.
  if (!sweptThisProcess) {
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
    sweptThisProcess = true;
    if (stranded.length > 0 || strandedOutbox.length > 0)
      log.info(`swept ${stranded.length} event(s) + ${strandedOutbox.length} reply(ies) back into the queues`);
  }
  // watchdog health tick (slice 3): arm once, stamp immediately so a boot
  // that completed start is visible to the probe without waiting a minute —
  // a partial start reports its dead entries connected:false (the signal).
  healthTimer ??= setInterval(() => void writeChannelHealthStamp(), HEALTH_TICK_MS);
  await writeChannelHealthStamp();
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
  channelsStopped = false; // a boot (re)start lifts the stopped invariant
  const attempt = () => {
    if (done) return;
    void opts
      .start()
      .then((failed) => {
        // PARTIAL-START LAW: a resolved call with failed adapters is NOT
        // success — those channels must keep retrying (r5 finding)
        if (failed.length === 0) {
          done = true;
          // NULL the handle, not just clear it: rearm() checks `if (!timer)` —
          // a stale truthy handle would skip recreating the interval and the
          // next partial start would strand with zero retries (r1 review P1)
          if (timer) clearInterval(timer);
          timer = null;
        } else {
          log.warn(`channels: ${failed.length} adapter(s) not live — retrying every ${retryMs / 1000}s`);
        }
      })
      .catch((e) => log.error('channels: start attempt failed — retrying:', e));
  };
  timer = setInterval(attempt, retryMs);
  attempt();
  // settings-change re-arm (slice 4): a config edit after a clean start must
  // apply immediately AND keep the partial-start law — a re-arm start with
  // failures re-arms this loop (done flips back, timer recreated)
  retryControls = {
    rearm: () => {
      done = false;
      if (!timer) timer = setInterval(attempt, retryMs);
      attempt();
    },
    stopTimer: () => {
      if (timer) clearInterval(timer);
      timer = null;
      done = true;
    },
  };
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

let retryControls: { rearm: () => void; stopTimer: () => void } | null = null;
/** the stopped invariant: stopChannels disarms the re-arm AND the retry loop —
 * a stopped channels module stays stopped until the next boot */
let channelsStopped = false;

/** settings-update hook (settings router pattern, mirror of
 * onDispatcherSettingsChanged): start runs against the COMMITTED value —
 * added/enabled adapters start, removed/disabled ones stop, a config edit
 * under an unchanged adapter key restarts that adapter. A start that leaves
 * failures re-arms the boot retry loop (PARTIAL-START law). Never throws: a
 * failed re-arm must not fail the settings write (the committed value is
 * durable; the retry loop converges). A no-op after an explicit stopChannels
 * — resurrection belongs to the boot hook alone. */
export async function onChannelsSettingsChanged(start: () => Promise<string[]> = startChannels): Promise<void> {
  if (channelsStopped) return;
  try {
    const failed = await start();
    if (failed.length > 0) retryControls?.rearm();
  } catch (e) {
    retryControls?.rearm();
    log.error('channels: re-arm after settings change failed — retry loop re-armed:', e);
  }
}

export async function stopChannels(): Promise<void> {
  // enforce the stopped invariant: disarm the settings-change re-arm AND the
  // boot retry loop — after an explicit stopChannels nothing resurrects
  // adapters/workers/timers (a later onChannelsSettingsChanged is a no-op);
  // resurrection belongs to the boot hook alone
  channelsStopped = true;
  retryControls?.stopTimer();
  retryControls = null;
  // JOIN the start serialization: an in-flight re-arm start completes its
  // writes first, then the teardown below stops everything it started — the
  // final state is stopped, never a resurrected module (r3: a stop racing a
  // start could leave live adapters + health tick after the stop returned)
  await startChain.catch(() => [] as string[]);
  // disarm the health tick first: a stopped channels module must stop
  // stamping (the stale key is the probe's process-dead signal)
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  for (const [key, adapter] of activeAdapters) {
    await adapter.stop();
    activeAdapters.delete(key);
    activeConfigs.delete(key);
  }
  await workerHandle?.close();
  workerHandle = null;
  await outboxWorkerHandle?.close();
  outboxWorkerHandle = null;
  // an explicit stop/start cycle re-sweeps (a stopped channel's rows may have
  // lost their jobs while the worker was down)
  sweptThisProcess = false;
}
