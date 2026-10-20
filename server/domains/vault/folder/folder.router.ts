// Folder router — thin wiring only; business logic lives in folder.service.
// Mounted by vault.router under the `folders` namespace (wire paths stay
// /rpc/vault/folders/list, /rpc/vault/folders/save, ...).
import { os } from '@orpc/server';
import { z } from 'zod';

import { protectedProcedure, liveGenerator } from '../../kernel/kernel';
import { listFolders, saveFolder, removeFolder } from './folder.service';

export const folderRouter = os.router({
  list: protectedProcedure.handler(() => listFolders()),

  live: protectedProcedure.handler(() => liveGenerator(['vault'], listFolders)),

  save: protectedProcedure
    .input(
      z.strictObject({
        id: z.string().min(1).optional(),
        name: z.string().min(1).max(60),
      }),
    )
    .handler(({ input }) => saveFolder(input)),

  /** deleting a folder never deletes secrets — they fall back to uncategorized (FK SET NULL) */
  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(({ input }) => removeFolder(input)),
});
