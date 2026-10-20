// Secret service — vault secret rows: list mapping, audit trail, CRUD.
// Values are envelope-encrypted via ./secret-crypto.service; plaintext never
// leaves the server (list returns metadata + last-four hint only).
import { desc, eq } from 'drizzle-orm'
import { db } from '../../../db'
import {
  vaultAudit as vaultAuditTable, vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable,
} from '../../../db/schema'
import type { VaultSecretRow, VaultAuditRow } from '../../../../shared/types'
import { v7 as uuidv7 } from 'uuid'
import { encryptSecret, lastFourHint } from './secret-crypto.service'
import { folderExists } from '../folder/folder.service'
import { ORPCError, publishChange } from '../../kernel/kernel'

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

export async function listAudit(): Promise<VaultAuditRow[]> {
  const rows = await db.select().from(vaultAuditTable).orderBy(desc(vaultAuditTable.createdAt)).limit(200)
  return rows.map((r): VaultAuditRow => ({
    id: r.id,
    secretId: r.secretId,
    secretName: r.secretName,
    action: r.action as VaultAuditRow['action'],
    actorId: r.actorId,
    createdAt: r.createdAt.toISOString(),
  }))
}

async function audit(secretId: string | null, secretName: string, action: VaultAuditRow['action'], actorId: string): Promise<void> {
  await db.insert(vaultAuditTable).values({ id: uuidv7(), secretId, secretName, action, actorId })
}

export async function createSecret(input: { name: string, description: string, value: string, folderId: string | null }, actorId: string): Promise<VaultSecretRow> {
  if (input.folderId != null && !(await folderExists(input.folderId))) {
    throw new ORPCError('BAD_REQUEST', { message: 'folder not found' })
  }
  const inserted = await db.insert(vaultSecretsTable).values({
    id: uuidv7(),
    name: input.name,
    description: input.description,
    folderId: input.folderId,
    ciphertext: encryptSecret(input.value),
    lastFour: lastFourHint(input.value),
    createdBy: actorId,
  }).returning()
  await audit(inserted[0]!.id, input.name, 'create', actorId)
  await publishChange('vault', 'create')
  return toVaultRow(inserted[0]!)
}

/** value can be replaced but NEVER read back through the API; leaving it empty keeps the stored secret */
export async function updateSecret(input: { id: string, name: string, description: string, value?: string, folderId: string | null }, actorId: string): Promise<VaultSecretRow> {
  const { id, value, ...meta } = input
  if (meta.folderId != null && !(await folderExists(meta.folderId))) {
    throw new ORPCError('BAD_REQUEST', { message: 'folder not found' })
  }
  // empty/omitted value = metadata-only edit; the ciphertext is never re-sent by the client
  const rotated = value !== undefined && value.length > 0
  const updated = await db.update(vaultSecretsTable)
    .set({ ...meta, ...(rotated ? { ciphertext: encryptSecret(value), lastFour: lastFourHint(value) } : {}), updatedAt: new Date() })
    .where(eq(vaultSecretsTable.id, id)).returning()
  if (updated.length === 0) {
    throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
  }
  await audit(id, meta.name, 'update', actorId)
  await publishChange('vault', 'update')
  return toVaultRow(updated[0]!)
}

export async function removeSecret(input: { id: string }, actorId: string): Promise<{ ok: true }> {
  const deleted = await db.delete(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.id)).returning({ id: vaultSecretsTable.id, name: vaultSecretsTable.name })
  if (deleted.length === 0) {
    throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
  }
  await audit(null, deleted[0]!.name, 'delete', actorId)
  await publishChange('vault', 'delete')
  return { ok: true }
}
