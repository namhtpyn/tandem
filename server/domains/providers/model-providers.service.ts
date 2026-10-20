// Model provider + model catalog (model_providers).
// API keys are NEVER stored here — per-agent in the vault (fleet law).
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { modelProviders } from '../../db/schema'
import { ALL_ENDPOINTS } from '#shared/api-styles'

export type ModelProviderRow = {
  id: string
  label: string
  baseUrl: string
  /** set of API styles this endpoint speaks (validated against shared/api-styles.ts) */
  endpoints: string[]
  extraHeaders: Record<string, string> | null
  notes: string | null
}

export const modelProviderInputSchema = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  endpoints: z.array(z.enum(ALL_ENDPOINTS)).min(1),
  extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
  notes: z.string().max(500).optional(),
})

export async function listModelProviders() {
  const provs = await db.select().from(modelProviders)
  return provs.map(p => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    endpoints: p.endpoints as string[],
    extraHeaders: p.extraHeaders ? JSON.parse(p.extraHeaders) : null,
    notes: p.notes,
  }))
}

export async function providerInUse(providerId: string) {
  const { aiEmployees } = await import('../../db/schema')
  const rows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees).where(eq(aiEmployees.providerId, providerId))
  return rows.length > 0
}
