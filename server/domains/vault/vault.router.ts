import { os } from '@orpc/server'
import { secretRouter } from './secret/secret.router'
import { folderRouter } from './folder/folder.router'

export const vaultRouter = os.router({
  secrets: secretRouter,
  folders: folderRouter,
})
