import { os } from '@orpc/server';
// settings router — business logic lives in services/utils; this file only wires procedures
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';

import { db } from '../../db/index';
import { vaultSecrets as vaultSecretsTable } from '../../db/schema';
import { protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel';

async function getSettingsSnapshot() {
  const { getSettings } = await import('./settings.service');
  return await getSettings();
}

export const settingsRouter = os.router({
  /** plain GET (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => getSettingsSnapshot()),

  /** live app settings */
  live: protectedProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.SETTINGS], getSettingsSnapshot)),

  /** update settings (strict input, admin-only) */
  update: protectedProcedure
    .input(
      z.strictObject({
        disablePasswordLogin: z.boolean().optional(),
        companyName: z.string().min(1).max(60).optional(),
        runTimeoutMs: z
          .number()
          .int()
          .min(60_000)
          .max(6 * 60 * 60_000)
          .optional(),
        tasksPerAgent: z.number().int().min(1).max(32).optional(),
        companyPrompt: z.string().max(8000).optional(),
        internalLlm: z
          .strictObject({ providerId: z.string().min(1), model: z.string().min(1), keySecretId: z.string().min(1) })
          .nullable()
          .optional(),
        internalDecision: z
          .strictObject({ providerId: z.string().min(1), model: z.string().min(1), keySecretId: z.string().min(1) })
          .nullable()
          .optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { setSetting, deleteSetting, INTERNAL_ASSIGNMENT_KEYS } = await import('./settings.service');
      const { rebuildAuth } = await import('../auth/auth.service');
      const { getOidcProviders } = await import('../auth/oidc.service');
      // ---- validate FIRST: no row is written until every check has passed ----
      if (input.disablePasswordLogin === true) {
        const providers = await getOidcProviders();
        if (providers.length === 0) {
          throw new ORPCError('BAD_REQUEST', { message: 'configure an OIDC provider before disabling password login' });
        }
      }
      // Workspace AI assignments: provider must exist and speak the right kind;
      // key secret must exist (keys are write-only vault references).
      const assignments: Array<{ key: string; raw: string | null }> = [];
      if (input.internalLlm !== undefined || input.internalDecision !== undefined) {
        const provRows = await db.query.modelProviders.findMany({
          columns: { id: true, endpoints: true },
          orderBy: { id: 'asc' },
        });
        const validate = async (
          a: { providerId: string; model: string | null; keySecretId: string } | null,
          kind: 'LLM' | 'DECISION',
        ) => {
          if (!a) return null;
          const prov = provRows.find((p) => p.id === a.providerId);
          if (!prov)
            throw new ORPCError('BAD_REQUEST', { message: `internal ${kind.toLowerCase()} provider not found` });
          const eps = prov.endpoints as string[];
          const { endpointKind } = await import('#shared/api-styles');
          if (!eps.some((e) => endpointKind(e) === kind)) {
            throw new ORPCError('BAD_REQUEST', { message: `provider does not speak any ${kind} endpoint` });
          }
          const sec = await db
            .select({ id: vaultSecretsTable.id })
            .from(vaultSecretsTable)
            .where(eq(vaultSecretsTable.id, a.keySecretId));
          if (sec.length === 0)
            throw new ORPCError('BAD_REQUEST', { message: `internal ${kind.toLowerCase()} key secret not found` });
          return JSON.stringify({ providerId: a.providerId, model: a.model, keySecretId: a.keySecretId });
        };
        if (input.internalLlm !== undefined) {
          assignments.push({ key: INTERNAL_ASSIGNMENT_KEYS.LLM, raw: await validate(input.internalLlm, 'LLM') });
        }
        if (input.internalDecision !== undefined) {
          assignments.push({
            key: INTERNAL_ASSIGNMENT_KEYS.DECISION,
            raw: await validate(input.internalDecision, 'DECISION'),
          });
        }
      }
      // ---- commit: one transaction, so a failed write rolls back every earlier one ----
      await db.transaction(async (tx) => {
        if (input.disablePasswordLogin !== undefined) {
          await setSetting('disablePasswordLogin', input.disablePasswordLogin ? 'true' : 'false', tx);
        }
        if (input.companyName !== undefined) {
          await setSetting('companyName', input.companyName.trim(), tx);
        }
        if (input.companyPrompt !== undefined) {
          await setSetting('company_prompt', input.companyPrompt, tx);
        }
        if (input.tasksPerAgent !== undefined) {
          await setSetting('tasks_per_agent', String(input.tasksPerAgent), tx);
        }
        if (input.runTimeoutMs !== undefined) {
          await setSetting('run_timeout_ms', String(input.runTimeoutMs), tx);
        }
        for (const a of assignments) {
          if (a.raw) await setSetting(a.key, a.raw, tx);
          else await deleteSetting(a.key, tx);
        }
      });
      // ---- side effects AFTER commit: each re-reads the committed rows ----
      if (input.tasksPerAgent !== undefined) {
        // per-agent dispatch workers must re-sync to the new cap without a redeploy
        const { onDispatcherSettingsChanged } = await import('../tasks/dispatcher.service');
        await onDispatcherSettingsChanged();
      }
      await rebuildAuth();
      await publishChange(CHANGE_RESOURCE.SETTINGS, CHANGE_ACTION.UPDATE);
      return { ok: true };
    }),
});
