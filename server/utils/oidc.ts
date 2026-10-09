// OIDC provider registry — stored as JSON in tandem_settings (key: oidc_providers).
// Env fallback seeds ONE provider (legacy/simple deployments):
//   TANDEM_OIDC_ISSUER / TANDEM_OIDC_CLIENT_ID / TANDEM_OIDC_CLIENT_SECRET
//   TANDEM_OIDC_LABEL (display name, default "SSO")
// Runtime management lives at PUT/GET /api/oidc.
import { z } from 'zod'
import { getSetting, setSetting } from './settings'

export interface OidcProvider {
  id: string
  label: string
  issuer: string
  clientId: string
  clientSecret: string
}

export const oidcProviderSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  issuer: z.string().url(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(400),
})

const REGISTRY_KEY = 'oidc_providers'

export async function getOidcProviders(): Promise<OidcProvider[]> {
  const raw = await getSetting(REGISTRY_KEY)
  if (raw) {
    try {
      const parsed = z.array(oidcProviderSchema).safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
      console.warn('[tandem] stored OIDC registry failed validation — ignoring')
    }
    catch {
      console.warn('[tandem] stored OIDC registry is not valid JSON — ignoring')
    }
  }
  // env fallback
  const env = process.env
  if (env.TANDEM_OIDC_ISSUER && env.TANDEM_OIDC_CLIENT_ID && env.TANDEM_OIDC_CLIENT_SECRET) {
    return [{
      id: 'oidc',
      label: env.TANDEM_OIDC_LABEL || 'SSO',
      issuer: env.TANDEM_OIDC_ISSUER,
      clientId: env.TANDEM_OIDC_CLIENT_ID,
      clientSecret: env.TANDEM_OIDC_CLIENT_SECRET,
    }]
  }
  return []
}

export async function saveOidcProviders(providers: OidcProvider[]): Promise<void> {
  await setSetting(REGISTRY_KEY, JSON.stringify(providers))
}
