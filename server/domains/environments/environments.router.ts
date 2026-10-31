import { os } from '@orpc/server';
// environments router — business logic lives in services/utils; this file only wires procedures
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';
import { SECRET_USAGE, type SecretUsage } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import {
  aiEmployees as aiEmployeesTable,
  environments as environmentsTable,
  user as userTable,
  vaultSecrets as vaultSecretsTable,
} from '../../db/schema';
import { ORPCError, adminProcedure, liveGenerator, protectedProcedure, publishChange } from '../kernel/kernel';
import { decryptSecret } from '../vault/secret/secret-crypto.service';
import { listEnvironments, listEnvironmentsPaged, toRow } from './environments.service';
import { environmentInput, environmentUpdateInput } from './environments.util';
import { probeSsh } from './ssh-probe.service';

export const environmentsRouter = os.router({
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listEnvironments()),

  /** paged + searched rows for the environments manager table */
  listPaged: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(10),
        q: z.string().trim().optional(),
      }),
    )
    .handler(({ input }) => listEnvironmentsPaged(input)),

  /** live list — pushes a fresh snapshot on every environments change */
  live: protectedProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.ENVIRONMENTS], listEnvironments)),

  create: adminProcedure.input(environmentInput).handler(async ({ input }) => {
    const clash = await db
      .select({ id: environmentsTable.id })
      .from(environmentsTable)
      .where(eq(environmentsTable.name, input.name));
    if (clash.length > 0) {
      throw new ORPCError('CONFLICT', { message: `environment "${input.name}" already exists` });
    }
    if (input.secretId) {
      const secret = await db
        .select({ id: vaultSecretsTable.id })
        .from(vaultSecretsTable)
        .where(eq(vaultSecretsTable.id, input.secretId));
      if (secret.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' });
      }
    }
    const inserted = await db
      .insert(environmentsTable)
      .values({ id: uuidv7(), ...input })
      .returning();
    await publishChange(CHANGE_RESOURCE.ENVIRONMENTS, CHANGE_ACTION.CREATE);
    return toRow(nonNull(inserted[0]));
  }),

  update: adminProcedure.input(environmentUpdateInput).handler(async ({ input }) => {
    const { id, ...data } = input;
    if (data.name !== undefined) {
      const clash = await db
        .select({ id: environmentsTable.id })
        .from(environmentsTable)
        .where(eq(environmentsTable.name, data.name));
      if (clash.some((c: { id: string }) => c.id !== id)) {
        throw new ORPCError('CONFLICT', { message: `environment "${data.name}" already exists` });
      }
    }
    if (data.secretId) {
      const secret = await db
        .select({ id: vaultSecretsTable.id })
        .from(vaultSecretsTable)
        .where(eq(vaultSecretsTable.id, data.secretId));
      if (secret.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' });
      }
    }
    // partial update: only provided keys land in the patch — omitted port/secret
    // fields keep their stored values (the update schema carries no defaults)
    const updated = await db
      .update(environmentsTable)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.host !== undefined ? { host: data.host } : {}),
        ...(data.username !== undefined ? { username: data.username } : {}),
        ...(data.port !== undefined ? { port: data.port } : {}),
        ...(data.secretId !== undefined ? { secretId: data.secretId } : {}),
        ...(data.secretUsage !== undefined ? { secretUsage: data.secretUsage } : {}),
        updatedAt: new Date(),
      })
      .where(eq(environmentsTable.id, id))
      .returning();
    if (updated.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'environment not found' });
    }
    await publishChange(CHANGE_RESOURCE.ENVIRONMENTS, CHANGE_ACTION.UPDATE);
    return toRow(nonNull(updated[0]));
  }),

  remove: adminProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input }) => {
    // ai_employees.environment_id is ON DELETE RESTRICT — pre-check so the caller
    // gets a clean 4xx naming the employee instead of a raw 23503 FK violation
    const linkedUsers = await db
      .select({ name: userTable.name })
      .from(aiEmployeesTable)
      .innerJoin(userTable, eq(userTable.id, aiEmployeesTable.userId))
      .where(eq(aiEmployeesTable.environmentId, input.id))
      .limit(1);
    if (linkedUsers.length > 0) {
      throw new ORPCError('BAD_REQUEST', {
        message: `environment is in use by AI employee ${nonNull(linkedUsers[0]).name}`,
      });
    }
    const deleted = await db
      .delete(environmentsTable)
      .where(eq(environmentsTable.id, input.id))
      .returning({ id: environmentsTable.id });
    if (deleted.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'environment not found' });
    }
    await publishChange(CHANGE_RESOURCE.ENVIRONMENTS, CHANGE_ACTION.DELETE);
    return { ok: true };
  }),

  probe: adminProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input }) => {
    const rows = await db.query.environments.findMany({
      columns: { host: true, port: true, username: true, secretId: true, secretUsage: true },
      where: { id: { eq: input.id } },
      orderBy: { id: 'asc' },
    });
    const env = rows[0];
    if (!env) {
      throw new ORPCError('NOT_FOUND', { message: 'environment not found' });
    }
    // Linked vault secret: decrypt server-side (never exposed) and audit the use.
    let privateKey: string | undefined;
    let usage: SecretUsage = SECRET_USAGE.SSH_KEY;
    if (env.secretId) {
      const secretRows = await db.query.vaultSecrets.findMany({
        columns: { ciphertext: true },
        where: { id: { eq: env.secretId } },
        orderBy: { id: 'asc' },
      });
      const secret = secretRows[0];
      if (secret) {
        privateKey = decryptSecret(secret.ciphertext);
        usage = env.secretUsage === SECRET_USAGE.PASSWORD ? SECRET_USAGE.PASSWORD : SECRET_USAGE.SSH_KEY;
      }
    }
    const started = Date.now();
    const result = await probeSsh(env.host, env.port, env.username, privateKey, usage);
    return { ...result, durationMs: Date.now() - started };
  }),
});
