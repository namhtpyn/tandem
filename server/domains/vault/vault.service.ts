// vault service: row mapping + list helpers
import { desc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable } from '../../db/schema'
import type { VaultSecretRow } from '../../../shared/types'

export function toVaultRow(r: typeof vaultSecretsTable.$inferSelect): VaultSecretRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    lastFour: r.lastFour,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    folder: null,
  }
}

export async function listVaultSecrets(): Promise<VaultSecretRow[]> {
  const rows = await db.select({ s: vaultSecretsTable, folderName: vaultFoldersTable.name })
    .from(vaultSecretsTable)
    .leftJoin(vaultFoldersTable, eq(vaultSecretsTable.folderId, vaultFoldersTable.id))
    .orderBy(desc(vaultSecretsTable.createdAt))
  return rows.map(({ s, folderName }) => ({ ...toVaultRow(s), folder: folderName }))
}

