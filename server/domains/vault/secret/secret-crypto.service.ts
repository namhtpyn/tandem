// Vault crypto: AES-256-GCM envelope encryption for tandem secrets.
//
// TANDEM_VAULT_KEY is REQUIRED — 32-byte key, base64. No hardcoded fallback:
// a key shipped in the repo is a key everyone has. Generate one with
// `openssl rand -base64 32` (or generateVaultKeyB64()) and put it in the
// stack env. Losing it loses every stored secret — back it up.
//
// Ciphertext format: v1:<b64 iv>:<b64 authTag>:<b64 ciphertext>
// The key NEVER ships to the client; decrypt() is server-import-only.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '../../kernel/env';

let cachedKey: Buffer | null = null;

export function getVaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  // boot validation guarantees 32 bytes; the guard covers test overrides
  const raw = env.TANDEM_VAULT_KEY;
  if (!raw) throw new Error('TANDEM_VAULT_KEY is required — set it to a 32-byte base64 key (openssl rand -base64 32)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`TANDEM_VAULT_KEY must decode to 32 bytes (got ${key.length})`);
  }
  cachedKey = key;
  return key;
}

/** Generate a fresh vault key (base64) — for prod bootstrap. */
export function generateVaultKeyB64() {
  return randomBytes(32).toString('base64');
}

/** Test hook: drop the cached key so env changes take effect. */
export function resetVaultKeyCache() {
  cachedKey = null;
}

export function encryptSecret(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(envelope: string) {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('malformed vault envelope');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ct = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getVaultKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Display hint: last 4 chars of the plaintext, never more. */
export function lastFourHint(plaintext: string) {
  return plaintext.length <= 4 ? '••••' : plaintext.slice(-4);
}
