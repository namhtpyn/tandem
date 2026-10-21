// Folder service — vault folders with per-folder secret counts.
// Duplicate folder names are allowed (the unique constraint was dropped);
// deleting a folder never deletes secrets — they fall back to uncategorized
// (FK SET NULL).
import { asc, count, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { db } from '../../../db';
import { vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable } from '../../../db/schema';
import { ORPCError, publishChange } from '../../kernel/kernel';
import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';

export type FolderWithCount = { id: string; name: string; secrets: number };

export async function listFolders() {
  const rows = await db.select().from(vaultFoldersTable).orderBy(asc(vaultFoldersTable.name));
  const counts = await db
    .select({ folderId: vaultSecretsTable.folderId, count: count() })
    .from(vaultSecretsTable)
    .groupBy(vaultSecretsTable.folderId);
  const byFolder = new Map(counts.map((c) => [c.folderId, Number(c.count)]));
  return { folders: rows.map((f) => ({ id: f.id, name: f.name, secrets: byFolder.get(f.id) ?? 0 })) };
}

export async function folderExists(id: string) {
  const rows = await db
    .select({ id: vaultFoldersTable.id })
    .from(vaultFoldersTable)
    .where(eq(vaultFoldersTable.id, id));
  return rows.length > 0;
}

export async function saveFolder(input: { id?: string; name: string }) {
  if (input.id === undefined) {
    const inserted = await db.insert(vaultFoldersTable).values({ id: uuidv7(), name: input.name }).returning();
    await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.CREATE);
    return { id: inserted[0]!.id };
  }
  const updated = await db
    .update(vaultFoldersTable)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(vaultFoldersTable.id, input.id))
    .returning();
  if (updated.length === 0) throw new ORPCError('NOT_FOUND', { message: 'folder not found' });
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.UPDATE);
  return { id: updated[0]!.id };
}

export async function removeFolder(input: { id: string }) {
  const deleted = await db
    .delete(vaultFoldersTable)
    .where(eq(vaultFoldersTable.id, input.id))
    .returning({ id: vaultFoldersTable.id });
  if (deleted.length === 0) throw new ORPCError('NOT_FOUND', { message: 'folder not found' });
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.REMOVE);
  return { ok: true };
}
