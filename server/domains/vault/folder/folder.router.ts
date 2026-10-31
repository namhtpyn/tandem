// Folder router — thin wiring only; business logic lives in folder.service.
// Mounted by vault.router under the `folders` namespace (wire paths stay
// /rpc/vault/folders/list, /rpc/vault/folders/save, ...).
import { os } from '@orpc/server';
import { z } from 'zod';

const listFoldersPagedInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
  q: z.string().trim().max(60).optional(),
});

const listFolderOptionsInput = z.object({
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  q: z.string().trim().optional(),
});

import { CHANGE_RESOURCE } from '#shared/enums';

import { adminProcedure, liveGenerator } from '../../kernel/kernel';
import { listFolders, listFoldersPaged, listFolderOptions, saveFolder, removeFolder } from './folder.service';

export const folderRouter = os.router({
  list: adminProcedure.handler(() => listFolders()),

  /** paged {id,name} option rows for pickers — no secret counts */
  options: adminProcedure.input(listFolderOptionsInput).handler(({ input }) => listFolderOptions(input)),

  listPaged: adminProcedure.input(listFoldersPagedInput).handler(({ input }) => listFoldersPaged(input)),

  live: adminProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.VAULT], listFolders)),

  /** create/rename a folder (admin-only write) */
  save: adminProcedure
    .input(
      z.strictObject({
        id: z.string().min(1).optional(),
        name: z.string().min(1).max(60),
      }),
    )
    .handler(({ input }) => saveFolder(input)),

  /** deleting a folder never deletes secrets — they fall back to uncategorized (FK SET NULL) */
  remove: adminProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(({ input }) => removeFolder(input)),
});
