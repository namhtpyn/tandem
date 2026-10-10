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

export interface AppSettings {
  disablePasswordLogin: boolean
  companyName: string
}

export async function getSettings(): Promise<AppSettings> {
  const v = await getSetting('disablePasswordLogin')
  const name = await getSetting('companyName')
  return { disablePasswordLogin: v === 'true', companyName: name?.trim() || 'Tandem' }
}
