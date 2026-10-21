// Secret service — vault secret rows: list mapping, audit trail, CRUD.
// Values are envelope-encrypted via ./secret-crypto.service; plaintext never
// leaves the server (list returns metadata + last-four hint only).
import { desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import type { VaultSecretRow } from '../../../../shared/types';
import { db } from '../../../db';
import { vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable } from '../../../db/schema';
import { ORPCError, publishChange } from '../../kernel/kernel';
import { folderExists } from '../folder/folder.service';
import { encryptSecret, lastFourHint } from './secret-crypto.service';
import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';

export function toVaultRow(r: typeof vaultSecretsTable.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    lastFour: r.lastFour,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    folder: null,
  };
}

export const listVaultSecretsInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  folderId: z.string().min(1).nullish(),
});

export async function listVaultSecrets(input: z.input<typeof listVaultSecretsInput> = {}) {
  const { page, pageSize, folderId } = listVaultSecretsInput.parse(input);
  const { data, total } = await db.query.vaultSecrets.findManyAndCount({
    with: { folder: true },
    where: folderId ? { folderId: { eq: folderId } } : undefined,
    orderBy: (s, { desc }) => [desc(s.createdAt)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    data: data.map(({ folder, ...s }) => ({ ...toVaultRow(s), folder: folder?.name ?? null })),
    total,
  };
}

export async function createSecret(
  input: { name: string; description: string; value: string; folderId: string | null },
  actorId: string,
) {
  if (input.folderId != null && !(await folderExists(input.folderId))) {
    throw new ORPCError('BAD_REQUEST', { message: 'folder not found' });
  }
  const inserted = await db
    .insert(vaultSecretsTable)
    .values({
      id: uuidv7(),
      name: input.name,
      description: input.description,
      folderId: input.folderId,
      ciphertext: encryptSecret(input.value),
      lastFour: lastFourHint(input.value),
      createdBy: actorId,
    })
    .returning();
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.CREATE);
  return toVaultRow(inserted[0]!);
}

/** value can be replaced but NEVER read back through the API; leaving it empty keeps the stored secret */
export async function updateSecret(
  input: { id: string; name: string; description: string; value?: string; folderId: string | null },
  actorId: string,
) {
  const { id, value, ...meta } = input;
  if (meta.folderId != null && !(await folderExists(meta.folderId))) {
    throw new ORPCError('BAD_REQUEST', { message: 'folder not found' });
  }
  // empty/omitted value = metadata-only edit; the ciphertext is never re-sent by the client
  const rotated = value !== undefined && value.length > 0;
  const updated = await db
    .update(vaultSecretsTable)
    .set({
      ...meta,
      ...(rotated ? { ciphertext: encryptSecret(value), lastFour: lastFourHint(value) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(vaultSecretsTable.id, id))
    .returning();
  if (updated.length === 0) {
    throw new ORPCError('NOT_FOUND', { message: 'secret not found' });
  }
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.UPDATE);
  return toVaultRow(updated[0]!);
}

export async function removeSecret(input: { id: string }, actorId: string) {
  const deleted = await db
    .delete(vaultSecretsTable)
    .where(eq(vaultSecretsTable.id, input.id))
    .returning({ id: vaultSecretsTable.id, name: vaultSecretsTable.name });
  if (deleted.length === 0) {
    throw new ORPCError('NOT_FOUND', { message: 'secret not found' });
  }
  await publishChange(CHANGE_RESOURCE.VAULT, CHANGE_ACTION.DELETE);
  return { ok: true };
}
