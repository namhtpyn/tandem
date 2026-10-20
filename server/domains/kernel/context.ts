// Per-request server context: lazily-resolved better-auth session.
import type { ServerContext } from './kernel'
type AuthSessionPayload = {
  user: { id: string, name: string, email: string, role: 'admin' | 'employee' | 'viewer' }
}

export function buildServerContext(headers: Headers | undefined): ServerContext {
  let cached: AuthSessionPayload | null = null
  let resolved = false
  return {
    reqHeaders: headers,
    getSession: async (): Promise<AuthSessionPayload | null> => {
      if (resolved) return cached
      resolved = true
      const { getAuth } = await import('../auth/auth.service')
      const auth = await getAuth()
      const session = await auth.api.getSession({ headers: headers ?? new Headers() })
      if (!session) {
        cached = null
        return null
      }
      const rawRole = session.user.role ?? 'viewer'
      // DB column is text; the additionalField union guards writes, this
      // guard keeps reads honest
      const role: 'admin' | 'employee' | 'viewer'
        = rawRole === 'admin' || rawRole === 'employee' ? rawRole : 'viewer'
      cached = {
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role,
        },
      }
      return cached
    },
  }
}
