// In-process change bus for oRPC live queries (pathbridge pattern).
// Every mutation publishes; live generators re-emit fresh snapshots over SSE.
import { MemoryPublisher } from '@orpc/publisher/memory';

import { CHANGE_ACTION, type ChangeAction, CHANGE_RESOURCE, type ChangeResource } from '#shared/enums';

export type { ChangeAction, ChangeResource };
import { redisPubsub } from './pubsub';

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
      lastPublishedId = event.id; // redis echoes this back to us; bridge skips own events
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
    if (e.id === lastPublishedId) return; // own echo: already on the local bus
    void changeBus.publish('change', e);
  });
}

let lastPublishedId = '';
