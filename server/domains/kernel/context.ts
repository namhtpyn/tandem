import { ROLE, type Role } from '#shared/enums';

// Per-request server context: lazily-resolved better-auth session.
import type { AuthSessionPayload, ServerContext } from './kernel';

export function buildServerContext(headers: Headers | undefined): ServerContext {
  let cached: AuthSessionPayload | null = null;
  let resolved = false;

  /** one fresh better-auth lookup — the cache-free half used by live re-auth */
  const resolve = async (): Promise<AuthSessionPayload | null> => {
    const { getAuth } = await import('../auth/auth.service');
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: headers ?? new Headers() });
    if (!session) return null;
    const rawRole = session.user.role ?? ROLE.VIEWER;
    // DB column is text; the additionalField union guards writes, this
    // guard keeps reads honest
    const role: Role = rawRole === ROLE.ADMIN || rawRole === ROLE.EMPLOYEE ? rawRole : ROLE.VIEWER;
    return {
      sessionId: session.session?.id,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role,
        mustChangePassword: Boolean(session.user.mustChangePassword),
      },
    };
  };

  return {
    reqHeaders: headers,
    // public tier by default; auth middlewares override (SPEC "Roles & access")
    liveGate: { tier: 'public' },
    getSession: async (): Promise<AuthSessionPayload | null> => {
      if (resolved) return cached;
      resolved = true;
      cached = await resolve();
      return cached;
    },
    refreshSession: resolve,
  };
}
