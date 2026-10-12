import { os } from '@orpc/server'
import { z } from 'zod'
// oidc router — business logic lives in services/utils; this file only wires procedures
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'

export const oidcRouter = os.router({
  /** live provider list (secrets never leave the server) */
  live: protectedProcedure.handler(() => liveGenerator(['oidc'], async () => {
    const { getOidcProviders } = await import('../../utils/oidc')
    const providers = await getOidcProviders()
    return providers.map(p => ({
      id: p.id,
      label: p.label,
      issuer: p.issuer,
      clientId: p.clientId,
      hasSecret: p.clientSecret.length > 0,
    }))
  })),

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
      const { getOidcProviders, saveOidcProviders, oidcProviderSchema } = await import('../../utils/oidc')
      const { rebuildAuth } = await import('../../utils/auth')
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
          : crypto.randomUUID()
        result.push(oidcProviderSchema.parse({ id, label: p.label, issuer: p.issuer, clientId: p.clientId, clientSecret: secret }))
      }
      await saveOidcProviders(result)
      await rebuildAuth()
      await publishChange('oidc', 'update')
      return { ok: true, count: result.length }
    }),
})
