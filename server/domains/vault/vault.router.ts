import { os } from '@orpc/server'
// vault router — business logic lives in services/utils; this file only wires procedures
import { asc, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { listVaultSecrets, toVaultRow } from './vault.service'
import { decryptSecret, encryptSecret, lastFourHint } from './vault-crypto.service'
import {
  vaultAudit as vaultAuditTable, vaultSecrets as vaultSecretsTable, vaultFolders as vaultFoldersTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import type { VaultAuditRow } from '../../../shared/types'

export const vaultRouter = os.router({
  /** live list — metadata only; ciphertext never leaves the server */
  live: protectedProcedure.handler(() => liveGenerator(['vault'], listVaultSecrets)),

  /** audit trail, newest first */
  audit: protectedProcedure.handler(async () => {
    const rows = await db.select().from(vaultAuditTable).orderBy(desc(vaultAuditTable.at)).limit(200)
    return rows.map((r): VaultAuditRow => ({
      id: r.id,
      secretId: r.secretId,
      secretName: r.secretName,
      action: r.action as VaultAuditRow['action'],
      actorId: r.actorId,
      at: r.at.toISOString(),
    }))
  }),

  create: protectedProcedure
    .input(z.strictObject({
      name: z.string().min(1).max(100),
      description: z.string().max(500).default(''),
      value: z.string().min(1).max(64_000),
      folderId: z.string().min(1).nullable().default(null),
    }))
    .handler(async ({ input, context }) => {
      if (input.folderId != null) {
        const folder = await db.select({ id: vaultFoldersTable.id }).from(vaultFoldersTable).where(eq(vaultFoldersTable.id, input.folderId))
        if (folder.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'folder not found' })
      }
      const inserted = await db.insert(vaultSecretsTable).values({
        id: crypto.randomUUID(),
        name: input.name,
        description: input.description,
        folderId: input.folderId,
        ciphertext: encryptSecret(input.value),
        lastFour: lastFourHint(input.value),
        createdBy: context.session.user.id,
      }).returning()
      await db.insert(vaultAuditTable).values({
        id: crypto.randomUUID(),
        secretId: inserted[0]!.id,
        secretName: input.name,
        action: 'create',
        actorId: context.session.user.id,
      })
      await publishChange('vault', 'create')
      return toVaultRow(inserted[0]!)
    }),

  /** value can be replaced but NEVER read back through the API; leaving it empty keeps the stored secret */
  update: protectedProcedure
    .input(z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1).max(100),
      description: z.string().max(500).default(''),
      value: z.string().max(64_000).optional(),
      folderId: z.string().min(1).nullable().default(null),
    }))
    .handler(async ({ input, context }) => {
      const { id, value, ...meta } = input
      if (meta.folderId != null) {
        const folder = await db.select({ id: vaultFoldersTable.id }).from(vaultFoldersTable).where(eq(vaultFoldersTable.id, meta.folderId))
        if (folder.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'folder not found' })
      }
      // empty/omitted value = metadata-only edit; the ciphertext is never re-sent by the client
      const rotated = value !== undefined && value.length > 0
      const updated = await db.update(vaultSecretsTable)
        .set({ ...meta, ...(rotated ? { ciphertext: encryptSecret(value), lastFour: lastFourHint(value) } : {}), updatedAt: new Date() })
        .where(eq(vaultSecretsTable.id, id)).returning()
      if (updated.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
      }
      await db.insert(vaultAuditTable).values({
        id: crypto.randomUUID(),
        secretId: id,
        secretName: meta.name,
        action: 'update',
        actorId: context.session.user.id,
      })
      await publishChange('vault', 'update')
      return toVaultRow(updated[0]!)
    }),

  folders: {
    live: protectedProcedure
      .handler(() => liveGenerator(['vault'], async () => {
        const rows = await db.select().from(vaultFoldersTable).orderBy(asc(vaultFoldersTable.name))
        const counts = await db.select({ folderId: vaultSecretsTable.folderId, count: count() }).from(vaultSecretsTable).groupBy(vaultSecretsTable.folderId)
        const byFolder = new Map(counts.map(c => [c.folderId, Number(c.count)]))
        return { folders: rows.map(f => ({ id: f.id, name: f.name, secrets: byFolder.get(f.id) ?? 0 })) }
      })),

    save: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1).optional(),
        name: z.string().min(1).max(60),
      }))
      .handler(async ({ input }) => {
        if (input.id === undefined) {
          const dupe = await db.select({ id: vaultFoldersTable.id }).from(vaultFoldersTable).where(eq(vaultFoldersTable.name, input.name))
          if (dupe.length > 0) throw new ORPCError('BAD_REQUEST', { message: 'a folder with that name already exists' })
          const inserted = await db.insert(vaultFoldersTable).values({ id: crypto.randomUUID(), name: input.name }).returning()
          await publishChange('vault', 'create')
          return { id: inserted[0]!.id }
        }
        const updated = await db.update(vaultFoldersTable).set({ name: input.name, updatedAt: new Date() }).where(eq(vaultFoldersTable.id, input.id)).returning()
        if (updated.length === 0) throw new ORPCError('NOT_FOUND', { message: 'folder not found' })
        await publishChange('vault', 'update')
        return { id: updated[0]!.id }
      }),

    /** deleting a folder never deletes secrets — they fall back to uncategorized (FK SET NULL) */
    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const deleted = await db.delete(vaultFoldersTable).where(eq(vaultFoldersTable.id, input.id)).returning({ id: vaultFoldersTable.id })
        if (deleted.length === 0) throw new ORPCError('NOT_FOUND', { message: 'folder not found' })
        await publishChange('vault', 'remove')
        return { ok: true }
      }),
  },

  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const deleted = await db.delete(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.id)).returning({ id: vaultSecretsTable.id, name: vaultSecretsTable.name })
      if (deleted.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
      }
      await db.insert(vaultAuditTable).values({
        id: crypto.randomUUID(),
        secretId: null,
        secretName: deleted[0]!.name,
        action: 'delete',
        actorId: context.session.user.id,
      })
      await publishChange('vault', 'delete')
      return { ok: true }
    }),
})
