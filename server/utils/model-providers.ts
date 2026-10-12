// Model provider + model catalog (tandem_model_providers / tandem_models).
// API keys are NEVER stored here — per-agent in the vault (fleet law).
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { modelProviders } from '../db/schema'
import { ALL_API_STYLES } from '#shared/api-styles'

export interface ModelProviderRow {
  id: string
  label: string
  baseUrl: string
  /** set of API styles this endpoint speaks (validated against shared/api-styles.ts) */
  apiStyles: string[]
  /** vault secret id with the provider key (required for decision styles) */
  keySecretId: string | null
  extraHeaders: Record<string, string> | null
  notes: string | null
}

export const modelProviderInputSchema = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  apiStyles: z.array(z.enum(ALL_API_STYLES)).min(1),
  keySecretId: z.string().min(1).nullable().optional(),
  extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
  notes: z.string().max(500).optional(),
})

export async function listModelProviders(): Promise<ModelProviderRow[]> {
  const provs = await db.select().from(modelProviders)
  return provs.map(p => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    apiStyles: p.apiStyles as string[],
    keySecretId: p.keySecretId,
    extraHeaders: p.extraHeaders ? JSON.parse(p.extraHeaders) : null,
    notes: p.notes,
  }))
}

export async function providerInUse(providerId: string): Promise<boolean> {
  const { aiEmployees } = await import('../db/schema')
  const rows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees).where(eq(aiEmployees.providerId, providerId))
  return rows.length > 0
}
