import { os } from '@orpc/server'
import { z } from 'zod'
// oidc router — business logic lives in services/utils; this file only wires procedures
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import { v7 as uuidv7 } from 'uuid'

async function listOidcProviders() {
  const { getOidcProviders } = await import('../auth/oidc.service')
  const providers = await getOidcProviders()
  return providers.map(p => ({
    id: p.id,
    label: p.label,
    issuer: p.issuer,
    clientId: p.clientId,
    hasSecret: p.clientSecret.length > 0,
  }))
}

export const oidcRouter = os.router({
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listOidcProviders()),

  /** live provider list (secrets never leave the server) */
  live: protectedProcedure.handler(() => liveGenerator(['oidc'], listOidcProviders)),

  /** replace the provider registry (secrets write-only) */
  replace: protectedProcedure
    .input(z.strictObject({
      providers: z.array(z.strictObject({
        id: z.string().min(1).max(64).optional(),
        label: z.string().min(1).max(64),
        issuer: z.string().url(),
        clientId: z.string().min(1).max(200),
        clientSecret: z.string().max(400).optional(),
      })).max(10),
    }))
    .handler(async ({ input }) => {
      const { getOidcProviders, saveOidcProviders, oidcProviderSchema } = await import('../auth/oidc.service')
      const { rebuildAuth } = await import('../auth/auth.service')
      const existing = await getOidcProviders()
      const result = []
      for (const p of input.providers) {
        const secret = p.clientSecret && p.clientSecret.length > 0
          ? p.clientSecret
          : existing.find(x => x.id === p.id)?.clientSecret
        if (!secret) {
          throw new ORPCError('BAD_REQUEST', { message: `provider ${p.label}: clientSecret is required for new providers` })
        }
        const id = p.id && existing.some(x => x.id === p.id)
          ? p.id
          : uuidv7()
        result.push(oidcProviderSchema.parse({ id, label: p.label, issuer: p.issuer, clientId: p.clientId, clientSecret: secret }))
      }
      await saveOidcProviders(result)
      await rebuildAuth()
      await publishChange('oidc', 'update')
      return { ok: true, count: result.length }
    }),
})
