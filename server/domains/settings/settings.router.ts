import { os } from '@orpc/server'
// settings router — business logic lives in services/utils; this file only wires procedures
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
  modelProviders as modelProvidersTable, vaultSecrets as vaultSecretsTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'

async function getSettingsSnapshot() {
  const { getSettings } = await import('./settings.service')
  return await getSettings()
}

export const settingsRouter = os.router({
  /** plain GET (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => getSettingsSnapshot()),

  /** live app settings */
  live: protectedProcedure.handler(() => liveGenerator(['settings'], getSettingsSnapshot)),

  /** update settings (strict input) */
  update: protectedProcedure
    .input(z.strictObject({
      disablePasswordLogin: z.boolean().optional(),
      companyName: z.string().min(1).max(60).optional(),
      runTimeoutMs: z.number().int().min(60_000).max(6 * 60 * 60_000).optional(),
      tasksPerAgent: z.number().int().min(1).max(32).optional(),
      companyPrompt: z.string().max(8000).optional(),
      internalLlm: z.strictObject({ providerId: z.string().min(1), model: z.string().min(1), keySecretId: z.string().min(1) }).nullable().optional(),
      internalDecision: z.strictObject({ providerId: z.string().min(1), model: z.string().min(1), keySecretId: z.string().min(1) }).nullable().optional(),
    }))
    .handler(async ({ input }) => {
      const { setSetting, deleteSetting, INTERNAL_ASSIGNMENT_KEYS } = await import('./settings.service')
      const { rebuildAuth } = await import('../auth/auth.service')
      const { getOidcProviders } = await import('../auth/oidc.service')
      if (input.disablePasswordLogin === true) {
        const providers = await getOidcProviders()
        if (providers.length === 0) {
          throw new ORPCError('BAD_REQUEST', { message: 'configure an OIDC provider before disabling password login' })
        }
      }
      if (input.disablePasswordLogin !== undefined) {
        await setSetting('disablePasswordLogin', input.disablePasswordLogin ? 'true' : 'false')
      }
      if (input.companyName !== undefined) {
        await setSetting('companyName', input.companyName.trim())
      }
      if (input.companyPrompt !== undefined) {
        await setSetting('company_prompt', input.companyPrompt)
      }
      if (input.tasksPerAgent !== undefined) {
        await setSetting('tasks_per_agent', String(input.tasksPerAgent))
        // per-agent dispatch workers must re-sync to the new cap without a redeploy
        const { onDispatcherSettingsChanged } = await import('../tasks/dispatcher.service')
        await onDispatcherSettingsChanged()
      }
      if (input.runTimeoutMs !== undefined) {
        await setSetting('run_timeout_ms', String(input.runTimeoutMs))
      }
      // Workspace AI assignments: provider must exist and speak the right kind;
      // key secret must exist (keys are write-only vault references).
      if (input.internalLlm !== undefined || input.internalDecision !== undefined) {
        const provRows = await db.select().from(modelProvidersTable)
        const validate = async (a: { providerId: string, model: string | null, keySecretId: string } | null, kind: 'LLM' | 'DECISION') => {
          if (!a) return null
          const prov = provRows.find(p => p.id === a.providerId)
          if (!prov) throw new ORPCError('BAD_REQUEST', { message: `internal ${kind.toLowerCase()} provider not found` })
          const eps = prov.endpoints as string[]
          const { endpointKind } = await import('#shared/api-styles')
          if (!eps.some(e => endpointKind(e) === kind)) {
            throw new ORPCError('BAD_REQUEST', { message: `provider does not speak any ${kind} endpoint` })
          }
          const sec = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, a.keySecretId))
          if (sec.length === 0) throw new ORPCError('BAD_REQUEST', { message: `internal ${kind.toLowerCase()} key secret not found` })
          return JSON.stringify({ providerId: a.providerId, model: a.model, keySecretId: a.keySecretId })
        }
        if (input.internalLlm !== undefined) {
          const raw = await validate(input.internalLlm, 'LLM')
          if (raw) await setSetting(INTERNAL_ASSIGNMENT_KEYS.LLM, raw)
          else await deleteSetting(INTERNAL_ASSIGNMENT_KEYS.LLM)
        }
        if (input.internalDecision !== undefined) {
          const raw = await validate(input.internalDecision, 'DECISION')
          if (raw) await setSetting(INTERNAL_ASSIGNMENT_KEYS.DECISION, raw)
          else await deleteSetting(INTERNAL_ASSIGNMENT_KEYS.DECISION)
        }
      }
      await rebuildAuth()
      await publishChange('settings', 'update')
      return { ok: true }
    }),
})
