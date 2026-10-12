import { os } from '@orpc/server'
// providers router — business logic lives in services/utils; this file only wires procedures
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { ALL_ENDPOINTS, isAnthropicWire, atMostOneModelsEndpoint } from '#shared/api-styles'
import { modelCache, armCacheSweeper } from './models-cache'
import { decryptSecret } from '../../utils/vault-crypto'
import {
  modelProviders as modelProvidersTable, vaultAudit as vaultAuditTable, vaultSecrets as vaultSecretsTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'

export const providersRouter = os.router({
  /** live model-provider catalog (connection info only — no keys, no models) */
  live: protectedProcedure.handler(() => liveGenerator(['providers'], async () => {
    const { listModelProviders } = await import('../../utils/model-providers')
    return await listModelProviders()
  })),

  /** replace ONE provider (upsert by id) */
  save: protectedProcedure
    .input(z.strictObject({
      id: z.string().min(1).max(64).optional(),
      label: z.string().min(1).max(64),
      baseUrl: z.string().url(),
      endpoints: z.array(z.enum(ALL_ENDPOINTS)).min(1).refine(atMostOneModelsEndpoint, { message: 'only one /v1/models endpoint per provider' }),
      apiStyles: z.array(z.string()).optional(), // legacy alias, ignored
      extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
      notes: z.string().max(500).optional(),
    }))
    .handler(async ({ input }) => {
      const { modelProviderInputSchema } = await import('../../utils/model-providers')
      modelProviderInputSchema.parse(input)
      const id = input.id?.trim() || crypto.randomUUID()
      const now = new Date()
      const values = {
        id,
        label: input.label,
        baseUrl: input.baseUrl,
        endpoints: input.endpoints,
        extraHeaders: input.extraHeaders ? JSON.stringify(input.extraHeaders) : null,
        notes: input.notes ?? null,
        updatedAt: now,
      }
      await db.insert(modelProvidersTable).values(values)
        .onConflictDoUpdate({ target: modelProvidersTable.id, set: { label: values.label, baseUrl: values.baseUrl, endpoints: values.endpoints, extraHeaders: values.extraHeaders, notes: values.notes, updatedAt: now } })
      await publishChange('providers', 'update')
      return { id }
    }),

  /** autocomplete: known model names for a provider. Probes {base}/models
   *  on first ask using a TRANSIENT vault secret (audited `use`, never
   *  stored), cached in-memory per provider+secret for 5 minutes. Falls back
   *  to an empty list when no secret is given. */
  models: protectedProcedure
    .input(z.strictObject({
      providerId: z.string().min(1),
      keySecretId: z.string().min(1).optional(),
    }))
    .handler(async ({ input, context }): Promise<{ models: string[] }> => {
      const provRows = await db.select().from(modelProvidersTable).where(eq(modelProvidersTable.id, input.providerId))
      const prov = provRows[0]
      if (!prov) throw new ORPCError('BAD_REQUEST', { message: 'provider does not exist' })

      if (!input.keySecretId) {
        return { models: modelCache.get(prov.id) ?? [] }
      }

      const cacheKey = `${prov.id}:${input.keySecretId}`
      const hit = modelCache.get(cacheKey)
      if (hit) return { models: hit }

      const secRows = await db.select().from(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.keySecretId))
      const secret = secRows[0]
      if (!secret) throw new ORPCError('BAD_REQUEST', { message: 'api key secret not found' })
      const key = decryptSecret(secret.ciphertext)
      await db.insert(vaultAuditTable).values({
        id: crypto.randomUUID(),
        secretId: secret.id,
        secretName: secret.name,
        action: 'use',
        actorId: context.session.user.id,
      })

      const provEndpoints = prov.endpoints as string[]
      const base = prov.baseUrl.replace(/\/$/, '')
      const anthropicWire = isAnthropicWire(provEndpoints)
      const url = `${base}/v1/models`
      const headers: Record<string, string> = prov.extraHeaders ? JSON.parse(prov.extraHeaders) : {}
      if (anthropicWire) {
        headers['x-api-key'] = key
        headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
      }
      else {
        headers.Authorization = `Bearer ${key}`
      }

      const models: string[] = []
      let after: string | null = null
      for (let page = 0; page < 10; page++) {
        const paged = after ? `${url}?after_id=${encodeURIComponent(after)}&limit=100` : `${url}?limit=100`
        let body: unknown
        try {
          const res = await fetch(paged, { headers, signal: AbortSignal.timeout(10_000) })
          if (!res.ok) throw new ORPCError('BAD_REQUEST', { message: `endpoint returned ${res.status}` })
          body = await res.json()
        }
        catch (e) {
          if (e instanceof ORPCError) throw e
          throw new ORPCError('BAD_REQUEST', { message: 'could not reach the endpoint' })
        }
        const payload = body as { data?: Array<{ id?: string }>, models?: Array<{ name?: string }>, has_more?: boolean, last_id?: string | null }
        const dataList = payload.data
        if (Array.isArray(dataList)) {
          models.push(...dataList.map(m => m.id).filter((m): m is string => typeof m === 'string' && m.length > 0))
        }
        const namedList = payload.models
        if (Array.isArray(namedList)) {
          models.push(...namedList.map(m => m.name).filter((m): m is string => typeof m === 'string' && m.length > 0))
        }
        if (!payload.has_more || !payload.last_id) break
        after = payload.last_id
      }
      const unique = [...new Set(models)].sort()
      armCacheSweeper()
      modelCache.set(cacheKey, unique)
      modelCache.set(prov.id, unique)
      return { models: unique }
    }),

  /** delete a provider (blocked while AI employees use it) */
  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input }) => {
      const { providerInUse } = await import('../../utils/model-providers')
      if (await providerInUse(input.id)) {
        throw new ORPCError('BAD_REQUEST', { message: 'provider is in use by AI employees' })
      }
      await db.delete(modelProvidersTable).where(eq(modelProvidersTable.id, input.id))
      await publishChange('providers', 'update')
      return { ok: true }
    }),
})
