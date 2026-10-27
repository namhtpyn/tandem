import { ORPCError, os } from '@orpc/server';
// oRPC v2 kernel: context type, base, protected procedure, live generator,
// change-bus re-exports. Modules import from here — never from each other's
// routers; services never import routers.
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins';

import type { Role } from '#shared/enums';

import { changeBus, publishChange, type ChangeEvent, type ChangeResource } from './change-bus';

export interface ServerContext extends RequestHeadersHandlerPluginContext {
  getSession: () => Promise<{
    user: { id: string; name: string; email: string; role: Role };
  } | null>;
}

export const base = os.$context<ServerContext>();

// Lazily resolve the better-auth session at most once per request; every
// sub-request in a batch shares the getter.
const requireSession = base.middleware(async ({ context, next }) => {
  const session = await context.getSession();
  if (!session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
  }
  return next({ context: { session } });
});

export const protectedProcedure = base.use(requireSession);

/** Live generator: initial snapshot, then fresh snapshots on relevant changes. */
export async function* liveGenerator<T>(resources: ChangeResource[], fetch: () => Promise<T>) {
  yield await fetch();
  for await (const evt of changeBus.subscribe('change')) {
    if (resources.includes(evt.resource)) {
      yield await fetch();
    }
  }
}

export { changeBus, publishChange };
export type ChangeBusEvent = ChangeEvent;
export { ORPCError };
