// GET /api/auth-config — public auth capabilities for the login screen.
import { resolveAuthPolicy } from '../utils/auth'

export interface AuthConfig {
  passwordEnabled: boolean
  oidcEnabled: boolean
  providers: Array<{ id: string, label: string }>
}

export default defineEventHandler(async (): Promise<AuthConfig> => {
  const p = await resolveAuthPolicy()
  return {
    passwordEnabled: p.passwordEnabled,
    oidcEnabled: p.oidcEnabled,
    providers: p.oidcProviders.map(x => ({ id: x.id, label: x.label })),
  }
})
