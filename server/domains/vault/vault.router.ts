import { os } from '@orpc/server';

import { folderRouter } from './folder/folder.router';
import { secretRouter } from './secret/secret.router';

export const vaultRouter = os.router({
  secrets: secretRouter,
  folders: folderRouter,
});
