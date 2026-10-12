// Runtime key/value settings in Postgres (tandem_settings). Typed getters with
// defaults; OIDC providers live under key 'oidc_providers' as JSON.
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return rows[0]?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date()
  await db.insert(settings).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key))
}

/** One Workspace AI assignment: provider + optional model + vault key (internal use only). */
export interface InternalAiAssignment {
  providerId: string
  model: string | null
  keySecretId: string
}

export interface AppSettings {
  disablePasswordLogin: boolean
  companyName: string
  /** LLM used by Tandem's own server-side features (null = unassigned). */
  internalLlm: InternalAiAssignment | null
  /** Decision engine used for auto-assign (null = unassigned). */
  internalDecision: InternalAiAssignment | null
}

/** Parse one assignment; invalid JSON or a non-object yields null. */
function parseAssignment(raw: string | null): InternalAiAssignment | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<InternalAiAssignment>
    if (typeof v.providerId !== 'string' || v.providerId.length === 0) return null
    if (typeof v.keySecretId !== 'string' || v.keySecretId.length === 0) return null
    return { providerId: v.providerId, model: typeof v.model === 'string' && v.model.length > 0 ? v.model : null, keySecretId: v.keySecretId }
  }
  catch {
    return null
  }
}

export async function getSettings(): Promise<AppSettings> {
  const v = await getSetting('disablePasswordLogin')
  const name = await getSetting('companyName')
  const llm = parseAssignment(await getSetting('internal_llm'))
  const decision = parseAssignment(await getSetting('internal_decision'))
  return { disablePasswordLogin: v === 'true', companyName: name?.trim() || 'Tandem', internalLlm: llm, internalDecision: decision }
}

export const INTERNAL_ASSIGNMENT_KEYS = { LLM: 'internal_llm', DECISION: 'internal_decision' } as const
export type InternalAssignmentKey = (typeof INTERNAL_ASSIGNMENT_KEYS)[keyof typeof INTERNAL_ASSIGNMENT_KEYS]
