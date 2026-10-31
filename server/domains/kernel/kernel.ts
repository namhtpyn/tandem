import { ORPCError, os } from '@orpc/server';
// oRPC v2 kernel: context type, base, protected procedure, role-gated
// procedures (Roles & access), live generator, change-bus re-exports. Modules
// import from here — never from each other's routers; services never import routers.
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins';

import { ROLE, type Role } from '#shared/enums';

import { changeBus, publishChange, type ChangeResource } from './change-bus';

export interface ServerContext extends RequestHeadersHandlerPluginContext {
  getSession: () => Promise<{
    /** credential origin — an id that resolves to an `apikey` row is an agent credential */
    sessionId?: string;
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

/** REVIEW LAW (SPEC "Roles & access"): verdict procedures (approve/
 *  requestChanges/reject) are HUMAN-only — the role gate plus a credential-
 *  origin check; a session backed by an API key (agent credential) is
 *  FORBIDDEN even with the right role. The origin lookup is lazy-imported so
 *  the db chain loads only when a human-only procedure executes. */
const requireHuman = (...allowed: Role[]) =>
  base.middleware(async ({ context, next }) => {
    const session = await context.getSession();
    if (!session) {
      throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
    }
    if (!allowed.includes(session.user.role)) {
      throw new ORPCError('FORBIDDEN', { message: 'insufficient role' });
    }
    const { isApiKeySession } = await import('./session-origin');
    if (await isApiKeySession(session.sessionId)) {
      throw new ORPCError('FORBIDDEN', { message: 'review verdicts are human-only' });
    }
    return next({ context: { session } });
  });

export const humanProcedure = base.use(requireHuman(ROLE.EMPLOYEE, ROLE.ADMIN));

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
export { ORPCError };
