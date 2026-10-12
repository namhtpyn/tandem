import { os } from '@orpc/server'
// auth router — business logic lives in services/utils; this file only wires procedures
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'

export const authRouter = os.router({
  /** public auth capabilities for the login screen (live) */
  configLive: base.handler(() => liveGenerator(['settings', 'oidc'], async () => {
    const { resolveAuthPolicy } = await import('../../utils/auth')
    const { getSettings } = await import('../../utils/settings')
    const [p, s] = await Promise.all([resolveAuthPolicy(), getSettings()])
    return {
      passwordEnabled: p.passwordEnabled,
      oidcEnabled: p.oidcEnabled,
      providers: p.oidcProviders.map(x => ({ id: x.id, label: x.label })),
      companyName: s.companyName,
    }
  })),

  /** current session (null when anonymous) */
  session: base.handler(async ({ context }) => {
    const session = await context.getSession()
    return session
  }),
})
