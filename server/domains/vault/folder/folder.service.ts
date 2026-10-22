import { EmptyFilter, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';
// Folder service — vault folders with per-folder secret counts.
// Duplicate folder names are allowed (the unique constraint was dropped);
// deleting a folder never deletes secrets — they fall back to uncategorized
// (FK SET NULL).
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../../db/index';
import { vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable } from '../../../db/schema';
import { ORPCError, publishChange } from '../../kernel/kernel';

export type FolderWithCount = { id: string; name: string; secrets: number };

export type ListFoldersPagedInput = { page?: number; pageSize?: number; q?: string };

export async function listFoldersPaged(input: ListFoldersPagedInput = {}) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 10;
  const q = input.q;
  const [rows, total] = await Promise.all([
    db.query.vaultFolders.findMany({
      where: q ? { name: { ilike: `%${q}%` } } : EmptyFilter,
      orderBy: { name: 'asc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
      extras: {
        secrets:
          sql<number>`(select count(*) from ${vaultSecretsTable} where ${vaultSecretsTable.folderId} = "d0"."id")`.mapWith(
            Number,
          ),
      },
    }),
    db.query.vaultFolders.count(q ? { name: { ilike: `%${q}%` } } : EmptyFilter),
  ]);
  return {
    folders: rows.map((f) => ({ id: f.id, name: f.name, secrets: Number(f.secrets ?? 0) })),
    total,
  };
}

export async function listFolders() {
  const rows = await db.query.vaultFolders.findMany({
    orderBy: { name: 'asc' },
    with: { secrets: { columns: { id: true } } },
  });
  return {
    folders: rows.map((f) => ({ id: f.id, name: f.name, secrets: f.secrets.length })),
  };
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
    return { id: nonNull(inserted[0]).id };
  }
  const updated = await db
    .update(vaultFoldersTable)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(vaultFoldersTable.id, input.id))
    .returning();
  if (updated.length === 0) throw new ORPCError('NOT_FOUND', { message: 'folder not found' });
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.UPDATE);
  return { id: nonNull(updated[0]).id };
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
