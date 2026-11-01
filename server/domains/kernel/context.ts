import { ROLE, type Role } from '#shared/enums';

// Per-request server context: lazily-resolved better-auth session.
import type { ServerContext } from './kernel';
type AuthSessionPayload = {
  /** credential origin (SPEC "Roles & access"): better-auth's apiKey plugin
   *  fabricates the session for an x-api-key request with session.id =
   *  apiKey.id — a human login always carries a `session` row id here */
  sessionId?: string;
  user: { id: string; name: string; email: string; role: Role; mustChangePassword?: boolean };
};

export function buildServerContext(headers: Headers | undefined): ServerContext {
  let cached: AuthSessionPayload | null = null;
  let resolved = false;
  return {
    reqHeaders: headers,
    getSession: async (): Promise<AuthSessionPayload | null> => {
      if (resolved) return cached;
      resolved = true;
      const { getAuth } = await import('../auth/auth.service');
      const auth = await getAuth();
      const session = await auth.api.getSession({ headers: headers ?? new Headers() });
      if (!session) {
        cached = null;
        return null;
      }
      const rawRole = session.user.role ?? ROLE.VIEWER;
      // DB column is text; the additionalField union guards writes, this
      // guard keeps reads honest
      const role: Role = rawRole === ROLE.ADMIN || rawRole === ROLE.EMPLOYEE ? rawRole : ROLE.VIEWER;
      cached = {
        sessionId: session.session?.id,
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role,
          mustChangePassword: Boolean(session.user.mustChangePassword),
        },
      };
      return cached;
    },
  };
}
