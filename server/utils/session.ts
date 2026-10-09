// Session guard for internal APIs — session cookie via better-auth getSession.
import type { H3Event } from 'h3'
import { getAuth } from './auth'

export type AppSession = Awaited<ReturnType<AuthApi['getSession']>>

type AuthApi = {
  getSession: (opts: { headers: Headers }) => Promise<{
    user: { id: string, name: string, email: string, emailVerified: boolean, image?: string | null, role?: string | null }
    session: { id: string, userId: string, expiresAt: Date }
  } | null>
}

export async function requireSession(event: H3Event) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(event.node.req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const item of v) headers.append(k, item)
    else headers.set(k, v)
  }
  const auth = await getAuth()
  const session = await auth.api.getSession({ headers })
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return session
}
