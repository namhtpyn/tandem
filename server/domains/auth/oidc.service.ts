// OIDC provider registry — stored as JSON in settings (key: oidc_providers),
// envelope-encrypted at rest via the vault crypto (TANDEM_VAULT_KEY).
// Env fallback seeds ONE provider (legacy/simple deployments):
//   TANDEM_OIDC_ISSUER / TANDEM_OIDC_CLIENT_ID / TANDEM_OIDC_CLIENT_SECRET
//   TANDEM_OIDC_LABEL (display name, default "SSO")
// Runtime management lives at PUT/GET /api/oidc.
import { consola } from 'consola';
import { z } from 'zod';

import { env } from '../kernel/env';
import { getSetting, setSetting } from '../settings/settings.service';
import { decryptSecret, encryptSecret } from '../vault/secret/secret-crypto.service';

const log = consola.withTag('tandem');

export type OidcProvider = {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
};

export const oidcProviderSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  issuer: z.url(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(400),
});

const REGISTRY_KEY = 'oidc_providers';

/** parse + validate one registry JSON document; null = unusable */
function parseRegistry(json: string): OidcProvider[] | null {
  try {
    const parsed = z.array(oidcProviderSchema).safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
    log.warn('stored OIDC registry failed validation — ignoring');
  } catch {
    log.warn('stored OIDC registry is not valid JSON — ignoring');
  }
  return null;
}

async function loadStoredRegistry(): Promise<OidcProvider[] | null> {
  const raw = await getSetting(REGISTRY_KEY);
  if (!raw) return null;
  // the blob is envelope-encrypted at rest; a pre-encryption plaintext registry
  // (or corrupted value) is not a valid envelope and is parsed/fallback as-is
  let json = raw;
  try {
    json = decryptSecret(raw);
  } catch {
    // not a vault envelope — keep raw for the legacy-plaintext path below
  }
  return parseRegistry(json);
}

/** Integrity probe (SPEC: Health — settings integrity): true iff raw is a
 * stored registry value the read path accepts. Missing (null/empty) is valid;
 * an envelope decrypts then schema-parses, legacy plaintext parses as-is.
 * Uses the reader's own decrypt + schema — never a divergent copy. */
export async function isValidStoredRegistry(raw: string | null): Promise<boolean> {
  if (!raw) return true;
  let json = raw;
  try {
    json = decryptSecret(raw);
  } catch {
    // not a vault envelope — legacy-plaintext path
  }
  return parseRegistry(json) !== null;
}

export async function getOidcProviders() {
  const stored = await loadStoredRegistry();
  if (stored) return stored;
  // env fallback (static vars from the boot contract)
  if (env.TANDEM_OIDC_ISSUER && env.TANDEM_OIDC_CLIENT_ID && env.TANDEM_OIDC_CLIENT_SECRET) {
    return [
      {
        id: 'oidc',
        label: env.TANDEM_OIDC_LABEL || 'SSO',
        issuer: env.TANDEM_OIDC_ISSUER,
        clientId: env.TANDEM_OIDC_CLIENT_ID,
        clientSecret: env.TANDEM_OIDC_CLIENT_SECRET,
      },
    ];
  }
  return [];
}

export async function saveOidcProviders(providers: OidcProvider[]) {
  // encrypt the WHOLE registry blob — settings rows are not secret-safe by default
  await setSetting(REGISTRY_KEY, encryptSecret(JSON.stringify(providers)));
}
