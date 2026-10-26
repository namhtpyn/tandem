// Secret router — thin wiring only; business logic lives in secret.service.
// Exported as a plain procedure record so vault.router can mount the
// procedures flat (wire paths stay /rpc/vault/list, /rpc/vault/create, ...).
import { z } from 'zod';

const listVaultSecretsInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  folderId: z.string().min(1).nullish(),
  q: z.string().trim().max(200).optional(),
});

import { CHANGE_RESOURCE } from '#shared/enums';

import { protectedProcedure, liveGenerator } from '../../kernel/kernel';
import { listVaultSecrets, createSecret, updateSecret, removeSecret } from './secret.service';

export const secretRouter = {
  /** live list — metadata only; ciphertext never leaves the server */
  list: protectedProcedure.input(listVaultSecretsInput).handler(({ input }) => listVaultSecrets(input)),

  live: protectedProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.VAULT], listVaultSecrets)),

  create: protectedProcedure
    .input(
      z.strictObject({
        name: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        value: z.string().min(1).max(64_000),
        folderId: z.string().min(1).nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => createSecret(input, context.session.user.id)),

  /** value can be replaced but NEVER read back through the API */
  update: protectedProcedure
    .input(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        value: z.string().max(64_000).optional(),
        folderId: z.string().min(1).nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => updateSecret(input, context.session.user.id)),

  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => removeSecret(input, context.session.user.id)),
};
