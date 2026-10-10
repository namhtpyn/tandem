// Model provider + model catalog (tandem_model_providers / tandem_models).
// API keys are NEVER stored here — per-agent in the vault (fleet law).
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { modelProviders, models } from '../db/schema'

export interface ModelProviderRow {
  id: string
  label: string
  baseUrl: string
  apiStyle: 'openai' | 'anthropic'
  extraHeaders: Record<string, string> | null
  notes: string | null
  modelNames: string[]
}

export const modelProviderInputSchema = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  apiStyle: z.enum(['openai', 'anthropic']),
  extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
  notes: z.string().max(500).optional(),
  modelNames: z.array(z.string().min(1).max(200)).max(100).default([]),
})

export async function listModelProviders(): Promise<ModelProviderRow[]> {
  const provs = await db.select().from(modelProviders)
  const mods = await db.select().from(models)
  return provs.map(p => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    apiStyle: p.apiStyle as 'openai' | 'anthropic',
    extraHeaders: p.extraHeaders ? JSON.parse(p.extraHeaders) : null,
    notes: p.notes,
    modelNames: mods.filter(m => m.providerId === p.id).map(m => m.name).sort(),
  }))
}

export async function providerInUse(providerId: string): Promise<boolean> {
  const { aiEmployees } = await import('../db/schema')
  const rows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees).where(eq(aiEmployees.providerId, providerId))
  return rows.length > 0
}
