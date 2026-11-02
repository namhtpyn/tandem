import { ORPCError, os } from '@orpc/server';
// oRPC v2 kernel: context type, base, protected procedure, role-gated
// procedures (Roles & access), live generator, change-bus re-exports. Modules
// import from here — never from each other's routers; services never import routers.
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins';

import { ROLE, type Role } from '#shared/enums';

import { changeBus, publishChange, type ChangeResource } from './change-bus';

export type AuthSessionPayload = {
  /** credential origin — an id that resolves to an `apikey` row is an agent credential */
  sessionId?: string;
  user: { id: string; name: string; email: string; role: Role; mustChangePassword?: boolean };
};

/** What a live stream must re-assert before emitting (SPEC "Roles & access",
 *  LIVE-STREAM RE-AUTH): the procedure's own tier, carried in the context by
 *  the middleware that admitted the request. Public streams carry `public`. */
export type LiveGate =
  | { tier: 'public' }
  | { tier: 'session' }
  | { tier: 'role'; roles: readonly Role[]; humanOnly: boolean };

export interface ServerContext extends RequestHeadersHandlerPluginContext {
  getSession: () => Promise<AuthSessionPayload | null>;
  /** fresh better-auth lookup — bypasses getSession's per-request latch */
  refreshSession: () => Promise<AuthSessionPayload | null>;
  /** the tier this request was admitted on; live generators re-assert it */
  liveGate: LiveGate;
}

const SESSION_LIVE_GATE: LiveGate = { tier: 'session' };

export const base = os.$context<ServerContext>();

// Lazily resolve the better-auth session at most once per request; every
// sub-request in a batch shares the getter.
const requireSession = base.middleware(async ({ context, next }) => {
  const session = await context.getSession();
  if (!session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
  }
  assertNotRotationLocked(session);
  return next({ context: { session, liveGate: SESSION_LIVE_GATE } });
});

export const protectedProcedure = base.use(requireSession);

/** ROTATION LOCK (SPEC "Boot seed law", #172): a session whose user still owes
 *  the forced first-login password change reaches exactly one procedure —
 *  auth.changeMyPassword (wired on lockedSessionProcedure). Everything above
 *  the public tier refuses before any other check. */
function assertNotRotationLocked(session: { user: { mustChangePassword?: boolean } }) {
  if (session.user.mustChangePassword) {
    throw new ORPCError('FORBIDDEN', { message: 'password change required' });
  }
}

/** the one procedure tier a rotation-locked session may pass: session resolved,
 *  lock NOT enforced — auth.changeMyPassword itself */
export const lockedSessionProcedure = base.use(
  base.middleware(async ({ context, next }) => {
    const session = await context.getSession();
    if (!session) {
      throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
    }
    return next({ context: { session, liveGate: SESSION_LIVE_GATE } });
  }),
);

/** Role gate (SPEC "Roles & access") — resolves the session (cached per
 *  request) and checks the role in one hop: anonymous → UNAUTHORIZED (401
 *  before 403), wrong role → FORBIDDEN; session stays injected downstream. */
const requireRole = (...allowed: Role[]) =>
  base.middleware(async ({ context, next }) => {
    const session = await context.getSession();
    if (!session) {
      throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
    }
    assertNotRotationLocked(session);
    if (!allowed.includes(session.user.role)) {
      throw new ORPCError('FORBIDDEN', { message: 'insufficient role' });
    }
    const liveGate: LiveGate = { tier: 'role', roles: allowed, humanOnly: false };
    return next({ context: { session, liveGate } });
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
    assertNotRotationLocked(session);
    if (!allowed.includes(session.user.role)) {
      throw new ORPCError('FORBIDDEN', { message: 'insufficient role' });
    }
    const { isApiKeySession } = await import('./session-origin');
    if (await isApiKeySession(session.sessionId)) {
      throw new ORPCError('FORBIDDEN', { message: 'review verdicts are human-only' });
    }
    const liveGate: LiveGate = { tier: 'role', roles: allowed, humanOnly: true };
    return next({ context: { session, liveGate } });
  });

export const humanProcedure = base.use(requireHuman(ROLE.EMPLOYEE, ROLE.ADMIN));

/** admin surfaces (vault, providers, oidc, env/employee/status/settings writes) */
export const adminProcedure = base.use(requireRole(ROLE.ADMIN));

/** Live-stream re-auth window (SPEC "Roles & access", LIVE-STREAM RE-AUTH):
 *  a long-lived stream revalidates at most once per window per stream, so a
 *  change burst never turns into a per-event session lookup. */
export const LIVE_REAUTH_MS = 5_000;

/** Re-assert the caller's tier with a FRESH session (never the per-request
 *  latch); throwing here tears the open stream down. */
export async function assertLiveAuthorized(context: ServerContext): Promise<void> {
  const gate = context.liveGate;
  if (gate.tier === 'public') return;
  const session = await context.refreshSession();
  if (!session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
  }
  assertNotRotationLocked(session);
  if (gate.tier === 'role' && !gate.roles.includes(session.user.role)) {
    throw new ORPCError('FORBIDDEN', { message: 'insufficient role' });
  }
  if (gate.tier === 'role' && gate.humanOnly) {
    const { isApiKeySession } = await import('./session-origin');
    if (await isApiKeySession(session.sessionId)) {
      throw new ORPCError('FORBIDDEN', { message: 'review verdicts are human-only' });
    }
  }
}

/** Throttled re-auth for one stream: call before every emit; the window is
 *  measured from the open-time check. */
export function liveReauthorizer(context: ServerContext) {
  let authorizedAt = Date.now();
  return async (): Promise<void> => {
    const now = Date.now();
    if (now - authorizedAt < LIVE_REAUTH_MS) return;
    await assertLiveAuthorized(context);
    authorizedAt = now;
  };
}

/** Live generator: initial snapshot, then fresh snapshots on relevant changes.
 *  Every emit after the re-auth window re-asserts the caller's tier first. */
export async function* liveGenerator<T>(resources: ChangeResource[], fetch: () => Promise<T>, context: ServerContext) {
  const reauthorize = liveReauthorizer(context);
  yield await fetch();
  for await (const evt of changeBus.subscribe('change')) {
    if (resources.includes(evt.resource)) {
      await reauthorize();
      yield await fetch();
    }
  }
}

export { changeBus, publishChange };
export { ORPCError };
