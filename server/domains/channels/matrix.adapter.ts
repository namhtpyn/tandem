// Matrix adapter — contract v1 transport over the raw Client-Server API
// (no SDK dep). Long-poll /sync loop, durable checkpoint, plain-text send.
// Slice-1 capabilities: unencrypted rooms only, no edits, no threads
// (SPEC: Channels). The adapter knows nothing about Tandem routing — it
// reports events into the core sink and advances the checkpoint AFTER the
// sink accepted the batch (persist-before-checkpoint, replay-safe).
import { consola } from 'consola';

import {
  capToMaxLen,
  registerChannelAdapter,
  type AdapterStartContext,
  type ChannelAdapter,
  type ChannelCapabilities,
} from './adapter';

const log = consola.withTag('channels');

export const MATRIX_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  threads: false,
  maxLen: 4000,
  markdown: false,
};

const SYNC_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// deliverable message types: m.text and m.notice (m.emote / m.file etc. are
// not slice-1 surface); encrypted rooms carry m.room.encrypted and never match
const DELIVERABLE_MSGTYPES = new Set(['m.text', 'm.notice']);

type SyncResponse = {
  next_batch?: string;
  user_id?: string;
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events?: Array<{ type?: string; sender?: string; event_id?: string; content?: unknown }> } }
    >;
  };
};

export function createMatrixAdapter(cfg: { homeserverUrl: string; token: string }): ChannelAdapter {
  const base = cfg.homeserverUrl.replace(/\/+$/, '');
  let controller: AbortController | null = null;
  let running = false;
  let selfUserId: string | null = null;
  let txnSeq = 0;

  async function api(
    path: string,
    init: { method: string; body?: unknown; timeoutMs: number },
  ): Promise<{
    ok: boolean;
    status: number;
    json: (SyncResponse & { errcode?: string; retry_after_ms?: number }) | null;
  }> {
    const timeoutSignal = AbortSignal.timeout(init.timeoutMs);
    const res = await fetch(`${base}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${cfg.token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // stop signal + per-request timeout: a half-open socket must never wedge
      // the loop (the caller's backoff path retries on TimeoutError)
      signal: controller ? AbortSignal.any([controller.signal, timeoutSignal]) : timeoutSignal,
    });
    const json = (await res.json().catch(() => null)) as
      | (SyncResponse & { errcode?: string; retry_after_ms?: number })
      | null;
    return { ok: res.ok, status: res.status, json };
  }

  function extractMessages(
    res: SyncResponse,
  ): Array<{ roomId: string; eventId: string; sender: string; text: string; raw: unknown }> {
    const out: Array<{ roomId: string; eventId: string; sender: string; text: string; raw: unknown }> = [];
    for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
      for (const ev of room.timeline?.events ?? []) {
        if (ev.type !== 'm.room.message' || !ev.event_id || !ev.sender) continue;
        if (selfUserId && ev.sender === selfUserId) continue; // never echo our own sends
        const content = ev.content as
          | { msgtype?: string; body?: unknown; 'm.relates_to'?: { rel_type?: string }; 'm.new_content'?: unknown }
          | undefined;
        if (typeof content?.body !== 'string' || content.body.length === 0) continue;
        if (!content.msgtype || !DELIVERABLE_MSGTYPES.has(content.msgtype)) continue;
        // edits (m.replace) and new_content payloads are not new messages —
        // delivering them would re-route the same thought as a fresh note
        if (content['m.relates_to']?.rel_type === 'm.replace' || content['m.new_content'] !== undefined) continue;
        out.push({ roomId, eventId: ev.event_id, sender: ev.sender, text: content.body, raw: ev });
      }
    }
    return out;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);

  /** the sync position the loop starts from. Throws on any start failure so
   * startChannels never registers a dead adapter as live.
   * FIRST-BOOT LAW (SPEC): initial sync with timeout=0, record next_batch,
   * deliver NOTHING. ECHO GUARD: whoami on EVERY start — the /sync response
   * carries no user id, and without it the bot's own acks re-enter the sink. */
  async function resolveStart(ctx: AdapterStartContext): Promise<string> {
    const since = await ctx.checkpoint.get();
    const who = await api('/_matrix/client/v3/account/whoami', { method: 'GET', timeoutMs: 15_000 });
    const uid = who.json?.user_id;
    if (!who.ok || typeof uid !== 'string' || uid.length === 0) {
      throw new Error(`whoami failed (status ${who.status}) — echo guard cannot arm`);
    }
    selfUserId = uid;
    if (since !== null) return since;
    const init = await api(`/_matrix/client/v3/sync?timeout=0&set_presence=offline`, {
      method: 'GET',
      timeoutMs: SYNC_TIMEOUT_MS,
    });
    if (!init.ok || !init.json?.next_batch) {
      throw new Error(
        `initial sync failed (status ${init.status}${init.json?.errcode ? ` ${init.json.errcode}` : ''})`,
      );
    }
    await ctx.checkpoint.set(init.json.next_batch);
    return init.json.next_batch;
  }

  /** M_UNKNOWN_POS: the checkpoint is no longer valid on the server (purged
   * timeline) — reset to "now" with a timeout=0 sync and resume from there. */
  async function resetSyncPosition(ctx: AdapterStartContext): Promise<string | null> {
    try {
      const init = await api(`/_matrix/client/v3/sync?timeout=0&set_presence=offline`, {
        method: 'GET',
        timeoutMs: SYNC_TIMEOUT_MS,
      });
      if (!init.ok || !init.json?.next_batch) return null;
      await ctx.checkpoint.set(init.json.next_batch);
      return init.json.next_batch;
    } catch {
      return null;
    }
  }

  /** transient-poll failure delay: 429 respects retry_after_ms, everything
   * else backs off exponentially. */
  function pollFailureDelayMs(json: { retry_after_ms?: number } | null, attempts: number): number {
    const retryAfter = json?.retry_after_ms;
    return typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : backoffMs(attempts);
  }

  /** deliver the batch into the sink, then advance the checkpoint. Returns
   * the new sync position, or null on sink failure (persist/enqueue outage) →
   * the caller re-polls the SAME since (durability law: never drop, never
   * double-count). */
  async function deliverBatch(
    ctx: AdapterStartContext,
    json: SyncResponse & { next_batch: string },
  ): Promise<string | null> {
    try {
      for (const m of extractMessages(json)) {
        await ctx.onMessage({
          threadRef: m.roomId,
          senderPlatformId: m.sender,
          text: m.text,
          raw: m.raw,
          externalId: m.eventId,
        });
      }
      await ctx.checkpoint.set(json.next_batch);
      return json.next_batch;
    } catch (e) {
      if (running) log.warn('channel sink failed — the batch will be re-read from the same checkpoint:', e);
      return null;
    }
  }

  async function syncLoop(ctx: AdapterStartContext, startSince: string): Promise<void> {
    let since = startSince;
    let backoffAttempts = 0;
    while (running) {
      let res;
      try {
        res = await api(
          `/_matrix/client/v3/sync?timeout=${SYNC_TIMEOUT_MS}&since=${encodeURIComponent(since)}&set_presence=offline`,
          { method: 'GET', timeoutMs: SYNC_TIMEOUT_MS + 10_000 },
        );
      } catch (e) {
        if (!running || (e instanceof Error && e.name === 'AbortError')) return; // clean stop
        backoffAttempts += 1;
        await sleep(backoffMs(backoffAttempts));
        continue;
      }
      // fatal auth: a dead token must stop the loop, not spin forever
      if ((res.status === 401 || res.status === 403) && res.json?.errcode === 'M_UNKNOWN_TOKEN') {
        log.error('matrix token rejected (M_UNKNOWN_TOKEN) — adapter stopped');
        running = false;
        return;
      }
      // stale checkpoint (purged timeline): skip to "now" once, then resume
      if (res.status === 400 && res.json?.errcode === 'M_UNKNOWN_POS') {
        log.warn('sync position rejected (M_UNKNOWN_POS) — resetting the checkpoint to now');
        const fresh = await resetSyncPosition(ctx);
        if (fresh !== null) {
          since = fresh;
          backoffAttempts = 0;
          continue;
        }
      }
      if (!res.ok || !res.json?.next_batch) {
        // the checkpoint did NOT advance — the next poll re-reads the same
        // events and the sink's dedupe makes replays no-ops
        backoffAttempts += 1;
        await sleep(pollFailureDelayMs(res.json, backoffAttempts));
        continue;
      }
      backoffAttempts = 0;
      const next = await deliverBatch(ctx, res.json as SyncResponse & { next_batch: string });
      if (next === null) {
        if (!running) return;
        backoffAttempts += 1;
        await sleep(backoffMs(backoffAttempts));
        continue;
      }
      since = next;
    }
  }

  return {
    kind: 'matrix',
    capabilities: MATRIX_CAPABILITIES,
    async start(ctx) {
      if (running) return;
      controller = new AbortController();
      running = true;
      try {
        // arm-don't-claim: resolveStart may throw (whoami/initial sync) —
        // a failed start must surface, not register a dead adapter as live
        const since = await resolveStart(ctx);
        void syncLoop(ctx, since).catch((e) => {
          log.error('matrix sync loop crashed:', e);
          running = false;
        });
      } catch (e) {
        running = false;
        controller = null;
        throw e;
      }
    },
    stop() {
      running = false;
      controller?.abort();
      controller = null;
      return Promise.resolve();
    },
    async send(target, text) {
      const txnId = `tandem-${Date.now()}-${(txnSeq += 1)}`;
      const res = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(target)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        body: { msgtype: 'm.text', body: capToMaxLen(text, MATRIX_CAPABILITIES) },
        timeoutMs: 15_000,
      });
      if (!res.ok) throw new Error(`matrix send failed: status ${res.status}`);
    },
  };
}

// self-registration: importing this file arms the 'matrix' kind in the core
// registry — a new channel kind = a new adapter file that does the same
registerChannelAdapter('matrix', (cfg) => {
  if (!cfg.homeserverUrl) throw new Error('matrix adapter requires homeserverUrl');
  return createMatrixAdapter({ homeserverUrl: cfg.homeserverUrl, token: cfg.token });
});
