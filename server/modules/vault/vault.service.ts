// vault service: row mapping + list helpers
import { desc } from 'drizzle-orm'
import { db } from '../../db'
import { environments as environmentsTable, vaultSecrets as vaultSecretsTable } from '../../db/schema'
import type { EnvironmentRow, VaultSecretRow } from '../../../shared/types'

export function toVaultRow(r: typeof vaultSecretsTable.$inferSelect): VaultSecretRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    lastFour: r.lastFour,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listVaultSecrets(): Promise<VaultSecretRow[]> {
  const rows = await db.select().from(vaultSecretsTable).orderBy(desc(vaultSecretsTable.createdAt))
  return rows.map(toVaultRow)
}

