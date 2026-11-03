// In-process change bus for oRPC live queries (pathbridge pattern).
// Every mutation publishes; live generators re-emit fresh snapshots over SSE.
import { MemoryPublisher } from '@orpc/publisher/memory';
import { consola } from 'consola';

import type { ChangeAction, ChangeResource } from '#shared/enums';

export type { ChangeAction, ChangeResource };
import { redisPubsub } from './pubsub';

const log = consola.withTag('tandem');

/** change-bus fanout channel + wire codec (encoded change events over pub/sub) */
export const CHANGE_CHANNEL = 'tandem:changes';

export function encodeChange(e: ChangeEvent) {
  return JSON.stringify(e);
}
export function decodeChange(raw: string): ChangeEvent {
  const e = JSON.parse(raw) as ChangeEvent;
  return { id: e.id, resource: e.resource, action: e.action, at: e.at };
}

export type ChangeEvent = {
  id: string;
  resource: ChangeResource;
  action: ChangeAction;
  at: string;
};

type Events = { change: ChangeEvent };

let seq = 0;
export const changeBus = new MemoryPublisher<Events>({
  maxBufferedEvents: 100,
});

/** Publish a data-change event; live queries re-run and push fresh rows.
 * With REDIS_URL set, events also fan out over Redis pub/sub so every replica's
 * local memory bus sees them (multi-replica live queries). */
export async function publishChange(resource: ChangeResource, action: ChangeAction) {
  seq += 1;
  const event: ChangeEvent = {
    id: `${Date.now()}-${seq}`,
    resource,
    action,
    at: new Date().toISOString(),
  };
  await changeBus.publish('change', event);
  try {
    const pubsub = await redisPubsub();
    if (pubsub) {
      // redis echoes this back to us; remember a window of ids so the bridge skips our own events
      rememberPublishedId(event.id);
      await pubsub.publish(CHANGE_CHANNEL, encodeChange(event)); // best-effort
    }
  } catch {
    /* redis down: local bus already got the event */
  }
}

/** boot hook: bridge Redis pub/sub -> local memory bus (no-op without REDIS_URL) */
export async function bridgeRedisChanges() {
  const pubsub = await redisPubsub();
  await pubsub.subscribe(CHANGE_CHANNEL, (raw) => {
    const e = decodeChange(raw);
    if (recentPublishedIds.has(e.id)) return; // own echo: already on the local bus
    void changeBus.publish('change', e);
  });
}

/** REDIS-BLIP BOOT LAW (#289): the boot-time bridge retries a bounded number of
 * attempts and then logs loudly and CONTINUES — a redis blip at restart must never
 * abort boot (the admin seed would never run) nor kill the process (crash-loop),
 * and a replica must never come up silently with no cross-replica fanout for its
 * whole lifetime (degraded fanout is VISIBLE in logs; the queue/pubsub paths
 * reconnect independently). Returns whether the bridge came up. */
export async function bridgeRedisChangesWithRetry(
  opts: { attempts?: number; delayMs?: number; log?: { warn: (m: string) => void; error: (m: string) => void } } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 2_000;
  const sink = opts.log ?? { warn: (m: string) => log.warn(m), error: (m: string) => log.error(m) };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await bridgeRedisChanges();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= attempts) {
        sink.error(
          `change-fanout bridge failed after ${attempt} attempt(s) — continuing with DEGRADED cross-replica fanout: ${msg}`,
        );
        return false;
      }
      sink.warn(`change-fanout bridge attempt ${attempt}/${attempts} failed — retrying: ${msg}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false; // unreachable (the loop returns on every path)
}

// Bounded window of ids we published: a single id raced with any overlapping
// publish (a later event overwrote it before its echo arrived, causing a dup).
const RECENT_PUBLISHED_MAX = 100;
const recentPublishedIds = new Set<string>();

function rememberPublishedId(id: string) {
  recentPublishedIds.add(id);
  if (recentPublishedIds.size > RECENT_PUBLISHED_MAX) {
    // Set preserves insertion order — evict the oldest id first
    const oldest = recentPublishedIds.values().next().value;
    if (oldest !== undefined) recentPublishedIds.delete(oldest);
  }
}
