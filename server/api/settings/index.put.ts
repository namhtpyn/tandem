// PUT /api/settings — auth/instance settings. Strict zod, session required.
import { z } from 'zod'
import { setSetting, getSettings } from '../../utils/settings'
import { rebuildAuth } from '../../utils/auth'
import { requireSession } from '../../utils/session'
import { getOidcProviders } from '../../utils/oidc'

const bodySchema = z.strictObject({
  disablePasswordLogin: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const body: unknown = await readBody(event)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    /* v8 ignore start -- zod always yields an issue on failure */
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid settings payload'
    throw createError({ statusCode: 400, statusMessage: message })
    /* v8 ignore stop */
  }
  const d = parsed.data

  // disabling password login requires at least one fully-configured provider
  if (d.disablePasswordLogin === true) {
    const providers = await getOidcProviders()
    if (providers.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'configure an OIDC provider before disabling password login' })
    }
  }

  if (d.disablePasswordLogin !== undefined) {
    await setSetting('disablePasswordLogin', d.disablePasswordLogin ? 'true' : 'false')
  }
  await rebuildAuth()
  return { ok: true }
})
