// GET /api/auth-session — session payload for SSR. Resolves the session
// IN-PROCESS with incoming headers (no outbound fetch through a proxy).
import { getAuth } from '../utils/auth'

export default defineEventHandler(async (event) => {
  const auth = await getAuth()
  const headers = new Headers()
  const cookie = getRequestHeaders(event).cookie
  if (cookie) headers.set('cookie', cookie)
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role ?? 'viewer' },
    session: { expiresAt: session.session.expiresAt },
  }
})
