import { EmptyFilter, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';
import { escapeIlike } from '#shared/utils/escape-ilike';
// Secret service — vault secret rows: list mapping, audit trail, CRUD.
// Values are envelope-encrypted via ./secret-crypto.service; plaintext never
// leaves the server (list returns metadata + last-four hint only).
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../../db/index';
import {
  aiEmployees as aiEmployeesTable,
  environments as environmentsTable,
  vaultSecrets as vaultSecretsTable,
} from '../../../db/schema';
import { ORPCError, publishChange } from '../../kernel/kernel';
import { folderExists } from '../folder/folder.service';
import { encryptSecret, lastFourHint } from './secret-crypto.service';

export function toVaultRow(r: typeof vaultSecretsTable.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    lastFour: r.lastFour,
    createdBy: r.createdBy,
    folderId: r.folderId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    folder: null,
  };
}

export type ListVaultSecretsInput = { page?: number; pageSize?: number; folderId?: string | null; q?: string };

export async function listVaultSecrets(input: ListVaultSecretsInput = {}) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const folderId = input.folderId;
  const q = input.q?.trim() || undefined;
  const folderFilter = folderId ? { folderId: { eq: folderId } } : undefined;
  const searchFilter = q
    ? { OR: [{ name: { ilike: `%${escapeIlike(q)}%` } }, { description: { ilike: `%${escapeIlike(q)}%` } }] }
    : undefined;
  const where =
    folderFilter && searchFilter
      ? { AND: [folderFilter, searchFilter] }
      : (folderFilter ?? searchFilter ?? EmptyFilter);
  const { data, total } = await db.query.vaultSecrets.findManyAndCount({
    with: { folder: true },
    where: where as never,
    orderBy: { createdAt: 'desc' },
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
  return toVaultRow(nonNull(inserted[0]));
}

/** value can be replaced but NEVER read back through the API; leaving it empty keeps the stored secret */
export async function updateSecret(
  input: { id: string; name: string; description: string; value?: string; folderId: string | null },
  _actorId: string,
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
  return toVaultRow(nonNull(updated[0]));
}

export async function removeSecret(input: { id: string }, _actorId: string) {
  // in-use guard: environments (ssh/password key) and AI employees (api key) keep
  // this secret alive — refuse like providers.remove instead of silently set-null
  const envLinks = await db
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(eq(environmentsTable.secretId, input.id))
    .limit(1);
  const aiLinks = await db
    .select({ userId: aiEmployeesTable.userId })
    .from(aiEmployeesTable)
    .where(eq(aiEmployeesTable.apiKeySecretId, input.id))
    .limit(1);
  if (envLinks.length > 0 || aiLinks.length > 0) {
    const blockers = [envLinks.length > 0 ? 'environments' : '', aiLinks.length > 0 ? 'AI employees' : ''].filter(
      Boolean,
    );
    throw new ORPCError('BAD_REQUEST', {
      message: `secret is in use by ${blockers.join(' and ')} — unlink or delete those first`,
    });
  }
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
