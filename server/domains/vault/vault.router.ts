// Vault router — pure composition: the secret procedures mount flat
// (/rpc/vault/list, /rpc/vault/create, ...) and the folder router nests under
// `folders` (/rpc/vault/folders/...). Business logic lives in the
// secret/ and folder/ services; crypto in secret/secret-crypto.service.
import { os } from '@orpc/server'
import { secretProcs } from './secret/secret.router'
import { folderRouter } from './folder/folder.router'

export const vaultRouter = os.router({
  ...secretProcs,
  folders: folderRouter,
})
