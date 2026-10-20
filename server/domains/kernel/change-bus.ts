// In-process change bus for oRPC live queries (pathbridge pattern).
// Every mutation publishes; live generators re-emit fresh snapshots over SSE.
import { MemoryPublisher } from '@orpc/publisher/memory';

import { CHANGE_CHANNEL, decodeChange, encodeChange, redisHub } from './redis';

export type ChangeResource =
  | 'environments'
  | 'settings'
  | 'oidc'
  | 'providers'
  | 'projects'
  | 'employees'
  | 'tasks'
  | 'taskActivity'
  | 'statuses'
  | 'runs'
  | 'vault';
export type ChangeAction = 'create' | 'update' | 'remove' | 'delete';

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
export async function publishChange(resource: ChangeResource, action: ChangeAction): Promise<void> {
  seq += 1;
  const event: ChangeEvent = {
    id: `${Date.now()}-${seq}`,
    resource,
    action,
    at: new Date().toISOString(),
  };
  await changeBus.publish('change', event);
  try {
    const hub = await redisHub();
    if (hub) {
      lastPublishedId = event.id; // redis echoes this back to us; bridge skips own events
      await hub.publish(CHANGE_CHANNEL, encodeChange(event)); // best-effort
    }
  } catch {
    /* redis down: local bus already got the event */
  }
}

/** boot hook: bridge Redis pub/sub -> local memory bus (no-op without REDIS_URL) */
export async function bridgeRedisChanges(): Promise<void> {
  const hub = await redisHub();
  if (!hub) return;
  await hub.subscribe(CHANGE_CHANNEL, (raw) => {
    const e = decodeChange(raw);
    if (e.id === lastPublishedId) return; // own echo: already on the local bus
    void changeBus.publish('change', e);
  });
}

let lastPublishedId = '';
