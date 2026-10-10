// In-process change bus for oRPC live queries (pathbridge pattern).
// Every mutation publishes; live generators re-emit fresh snapshots over SSE.
import { MemoryPublisher } from '@orpc/publisher/memory'

export type ChangeResource = 'environments' | 'settings' | 'oidc' | 'employees' | 'tasks' | 'runs' | 'vault'
export type ChangeAction = 'create' | 'update' | 'delete'

export type ChangeEvent = {
  id: string
  resource: ChangeResource
  action: ChangeAction
  at: string
}

type Events = { change: ChangeEvent }

let seq = 0
export const changeBus = new MemoryPublisher<Events>({
  maxBufferedEvents: 100,
})

/** Publish a data-change event; live queries re-run and push fresh rows. */
export async function publishChange(resource: ChangeResource, action: ChangeAction): Promise<void> {
  seq += 1
  await changeBus.publish('change', {
    id: `${Date.now()}-${seq}`,
    resource,
    action,
    at: new Date().toISOString(),
  })
}
