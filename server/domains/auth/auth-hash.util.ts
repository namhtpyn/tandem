// Thin re-export of better-auth's own password hasher (scrypt default) so the
// admin seed writes account rows better-auth can verify against.
// (Named function export — a bare `export { hashPassword } from ...` inlines to
// an empty module under nitro's rolldown bundling; the wrapper survives it.)
import { hashPassword as baHashPassword } from 'better-auth/crypto'

export async function hashPassword(password: string): Promise<string> {
  return await baHashPassword(password)
}
