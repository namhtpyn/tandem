// GET /api/oidc — list configured OIDC providers (secrets NEVER returned).
import { getOidcProviders } from '../../utils/oidc'
import { requireSession } from '../../utils/session'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const providers = await getOidcProviders()
  return {
    providers: providers.map(p => ({
      id: p.id,
      label: p.label,
      issuer: p.issuer,
      clientId: p.clientId,
      hasSecret: p.clientSecret.length > 0,
    })),
  }
})
