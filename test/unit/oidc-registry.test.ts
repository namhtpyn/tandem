import { beforeEach, describe, expect, it, vi } from 'vitest';

// boot env contract is irrelevant here — serve a valid vault key and no OIDC
// env fallback (DB-configured registry is the path under test)
vi.mock('../../server/domains/kernel/env', () => ({
  env: {
    TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    TANDEM_OIDC_ISSUER: undefined,
    TANDEM_OIDC_CLIENT_ID: undefined,
    TANDEM_OIDC_CLIENT_SECRET: undefined,
    TANDEM_OIDC_LABEL: undefined,
  },
}));

// OIDC registry persistence laws (issue #61): the registry blob is
// envelope-encrypted AT REST (write), the legacy-plaintext read fallback stays
// (rollback guarantee), and the settings allowlist NEVER leaks the registry.
// The db singleton is captured/mocked — no-real-DB unit law.
const writes: string[] = [];
const rows: Record<string, string> = {};
vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      settings: {
        findFirst: async (opts: { where?: { key?: { eq?: string } } }) => {
          const key = opts.where?.key?.eq ?? '';
          return key in rows ? { value: rows[key] } : null;
        },
      },
    },
    insert: () => ({
      values: (v: { value: string }) => {
        writes.push(v.value);
        return { onConflictDoUpdate: async () => {} };
      },
    }),
  },
  asDb: (x: unknown) => x,
}));

import { getOidcProviders, saveOidcProviders } from '../../server/domains/auth/oidc.service';
import { getSettings } from '../../server/domains/settings/settings.service';
import { decryptSecret, encryptSecret } from '../../server/domains/vault/secret/secret-crypto.service';

const PROVIDERS = [
  {
    id: 'entra',
    label: 'SSO',
    issuer: 'https://login.microsoftonline.com/tenant/v2.0',
    clientId: 'client-1',
    clientSecret: 'super-secret-value',
  },
];

const ENVELOPE_RE = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

beforeEach(() => {
  writes.length = 0;
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('OIDC registry at rest', () => {
  it('saveOidcProviders stores a vault envelope, never plaintext JSON', async () => {
    await saveOidcProviders(PROVIDERS);
    expect(writes).toHaveLength(1);
    const stored = writes[0]!;
    expect(stored).toMatch(ENVELOPE_RE);
    // the envelope decrypts back to exactly the registry (whole-blob roundtrip)
    expect(JSON.parse(decryptSecret(stored))).toEqual(PROVIDERS);
    expect(() => JSON.parse(stored)).toThrow();
  });

  it('getOidcProviders decrypts an envelope-stored registry', async () => {
    rows['oidc_providers'] = encryptSecret(JSON.stringify(PROVIDERS));
    expect(await getOidcProviders()).toEqual(PROVIDERS);
  });

  it('legacy-plaintext registry still parses (rollback guarantee)', async () => {
    // pre-encryption relic row shape — must stay readable so restoring a
    // plaintext row (rollback) keeps OIDC logins working
    rows['oidc_providers'] = JSON.stringify(PROVIDERS);
    expect(await getOidcProviders()).toEqual(PROVIDERS);
  });

  it('an unusable registry value yields [] instead of throwing', async () => {
    rows['oidc_providers'] = 'not-json-at-all';
    expect(await getOidcProviders()).toEqual([]);
  });
});

describe('settings allowlist pin (never exposes the OIDC registry)', () => {
  it('getSettings() output has a fixed key set and no secret material', async () => {
    // the row itself holds the (pre-fix plaintext relic) registry with a secret
    rows['oidc_providers'] = JSON.stringify(PROVIDERS);
    rows['disablePasswordLogin'] = 'false';
    rows['companyName'] = 'Acme';
    rows['run_timeout_ms'] = '7200000';
    rows['tasks_per_agent'] = '2';
    rows['company_prompt'] = 'be nice';
    const s = await getSettings();
    expect(Object.keys(s).sort()).toEqual([
      'companyName',
      'companyPrompt',
      'disablePasswordLogin',
      'internalDecision',
      'internalLlm',
      'peakEndHour',
      'peakMultiplier',
      'peakStartHour',
      'runTimeoutMs',
      'tasksPerAgent',
    ]);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('oidc_providers');
  });
});
