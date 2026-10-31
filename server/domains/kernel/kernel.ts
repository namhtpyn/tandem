import { ORPCError, os } from '@orpc/server';
// oRPC v2 kernel: context type, base, protected procedure, role-gated
// procedures (Roles & access), live generator, change-bus re-exports. Modules
// import from here — never from each other's routers; services never import routers.
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins';

import { ROLE, type Role } from '#shared/enums';

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

/** Role gate (SPEC "Roles & access") — resolves the session (cached per
 *  request) and checks the role in one hop: anonymous → UNAUTHORIZED (401
 *  before 403), wrong role → FORBIDDEN; session stays injected downstream. */
const requireRole = (...allowed: Role[]) =>
  base.middleware(async ({ context, next }) => {
    const session = await context.getSession();
    if (!session) {
      throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
    }
    if (!allowed.includes(session.user.role)) {
      throw new ORPCError('FORBIDDEN', { message: 'insufficient role' });
    }
    return next({ context: { session } });
  });

/** work-surface writes (tasks, projects, Jev auto-assign) — EMPLOYEE + ADMIN */
export const employeeProcedure = base.use(requireRole(ROLE.EMPLOYEE, ROLE.ADMIN));

/** admin surfaces (vault, providers, oidc, env/employee/status/settings writes) */
export const adminProcedure = base.use(requireRole(ROLE.ADMIN));

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
