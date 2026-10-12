import { os } from '@orpc/server'
// vault router — business logic lives in services/utils; this file only wires procedures
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { listVaultSecrets, toVaultRow } from './vault.service'
import { decryptSecret, encryptSecret, lastFourHint } from '../../utils/vault-crypto'
import {
  vaultAudit as vaultAuditTable, vaultSecrets as vaultSecretsTable,
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
    }))
    .handler(async ({ input, context }) => {
      const inserted = await db.insert(vaultSecretsTable).values({
        id: crypto.randomUUID(),
        name: input.name,
        description: input.description,
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

  /** value can be replaced but NEVER read back through the API */
  update: protectedProcedure
    .input(z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1).max(100),
      description: z.string().max(500).default(''),
      value: z.string().min(1).max(64_000),
    }))
    .handler(async ({ input, context }) => {
      const { id, value, ...meta } = input
      const updated = await db.update(vaultSecretsTable)
        .set({ ...meta, ciphertext: encryptSecret(value), lastFour: lastFourHint(value), updatedAt: new Date() })
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
