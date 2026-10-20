import { os } from '@orpc/server'
// environments router — business logic lives in services/utils; this file only wires procedures
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { environmentInput } from './environments.util'
import { probeSsh } from './ssh-probe.service'
import { decryptSecret } from '../vault/vault-crypto.service'
import {
  environments as environmentsTable, vaultAudit as vaultAuditTable, vaultSecrets as vaultSecretsTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import { toRow, listEnvironments } from './environments.service'
import { v7 as uuidv7 } from 'uuid'

export const environmentsRouter = os.router({
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listEnvironments()),

  /** live list — pushes a fresh snapshot on every environments change */
  live: protectedProcedure.handler(() => liveGenerator(['environments'], listEnvironments)),

  create: protectedProcedure
    .input(environmentInput)
    .handler(async ({ input }) => {
      const clash = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.name, input.name))
      if (clash.length > 0) {
        throw new ORPCError('CONFLICT', { message: `environment "${input.name}" already exists` })
      }
      if (input.secretId) {
        const secret = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.secretId))
        if (secret.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' })
        }
      }
      const inserted = await db.insert(environmentsTable).values({ id: uuidv7(), ...input }).returning()
      await publishChange('environments', 'create')
      return toRow(inserted[0]!)
    }),

  update: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1), ...environmentInput.shape }))
    .handler(async ({ input }) => {
      const { id, ...data } = input
      const clash = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.name, data.name))
      if (clash.some((c: { id: string }) => c.id !== id)) {
        throw new ORPCError('CONFLICT', { message: `environment "${data.name}" already exists` })
      }
      if (data.secretId) {
        const secret = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, data.secretId))
        if (secret.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' })
        }
      }
      const updated = await db.update(environmentsTable).set({ ...data, updatedAt: new Date() }).where(eq(environmentsTable.id, id)).returning()
      if (updated.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
      }
      await publishChange('environments', 'update')
      return toRow(updated[0]!)
    }),

  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input }) => {
      const deleted = await db.delete(environmentsTable).where(eq(environmentsTable.id, input.id)).returning({ id: environmentsTable.id })
      if (deleted.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
      }
      await publishChange('environments', 'delete')
      return { ok: true }
    }),

  probe: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const rows = await db.select().from(environmentsTable).where(eq(environmentsTable.id, input.id))
      const env = rows[0]
      if (!env) {
        throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
      }
      // Linked vault secret: decrypt server-side (never exposed) and audit the use.
      let privateKey: string | undefined
      let usage: 'ssh-key' | 'password' = 'ssh-key'
      if (env.secretId) {
        const secretRows = await db.select().from(vaultSecretsTable).where(eq(vaultSecretsTable.id, env.secretId))
        const secret = secretRows[0]
        if (secret) {
          privateKey = decryptSecret(secret.ciphertext)
          usage = env.secretUsage === 'password' ? 'password' : 'ssh-key'
          await db.insert(vaultAuditTable).values({
            id: uuidv7(),
            secretId: secret.id,
            secretName: secret.name,
            action: 'use',
            actorId: context.session.user.id,
          })
        }
      }
      const started = Date.now()
      const result = await probeSsh(env.host, env.port, env.username, privateKey, usage)
      return { ...result, durationMs: Date.now() - started }
    }),
})
