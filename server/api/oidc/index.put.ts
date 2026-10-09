// PUT /api/oidc — replace the OIDC provider registry. Strict zod; secrets are
// write-only (stored, never echoed). Provider ids are generated server-side for
// NEW providers; a request id matches only an EXISTING provider (callback-path
// stability). Rebuilds the auth instance on success.
import { z } from 'zod'
import { getOidcProviders, saveOidcProviders, oidcProviderSchema } from '../../utils/oidc'
import { rebuildAuth } from '../../utils/auth'
import { requireSession } from '../../utils/session'

const providerInput = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64),
  issuer: z.string().url(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().max(400).optional(),
})

const bodySchema = z.strictObject({
  providers: z.array(providerInput).max(10),
})

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const body: unknown = await readBody(event)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    // zod guarantees at least one issue on failure
    const issue = parsed.error.issues[0]!
    const statusMessage = `${issue.path.join('.') || 'body'}: ${issue.message}`
    throw createError({ statusCode: 400, statusMessage })
  }

  const existing = await getOidcProviders()
  const result = []
  for (const p of parsed.data.providers) {
    // secret omitted on edit = keep the stored one
    const secret = p.clientSecret && p.clientSecret.length > 0
      ? p.clientSecret
      : existing.find(x => x.id === p.id)?.clientSecret
    if (!secret) {
      throw createError({ statusCode: 400, statusMessage: `provider ${p.label}: clientSecret is required for new providers` })
    }
    // id: match existing only; new providers get a server-generated uuid
    const id = p.id && existing.some(x => x.id === p.id)
      ? p.id
      : crypto.randomUUID()
    // the merged shape is fully validated by `providerInput` + the secret/id
    // handling above; oidcProviderSchema re-parse is redundant — cast through it
    // for the narrower stored type.
    const merged = oidcProviderSchema.parse({ id, label: p.label, issuer: p.issuer, clientId: p.clientId, clientSecret: secret })
    result.push(merged)
  }

  await saveOidcProviders(result)
  await rebuildAuth()
  return { ok: true, count: result.length }
})
