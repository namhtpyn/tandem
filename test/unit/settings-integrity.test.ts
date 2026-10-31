// Settings integrity audit (#123, SPEC: Health — settings integrity): every
// KNOWN settings key's stored value must match the shape its write path
// produces; corrupt rows are the detect signal (readiness 503s while any
// exist). The db singleton is captured/mocked — no-real-DB unit law; the OIDC
// probe runs the REAL envelope crypto against a valid vault key.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// boot env contract is irrelevant here — serve a valid vault key
vi.mock('../../server/domains/kernel/env', () => ({
  env: {
    TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    TANDEM_OIDC_ISSUER: undefined,
    TANDEM_OIDC_CLIENT_ID: undefined,
    TANDEM_OIDC_CLIENT_SECRET: undefined,
    TANDEM_OIDC_LABEL: undefined,
  },
}));

// the db singleton is captured/mocked — no-real-DB unit law (issue #61 pattern)
const rows: Record<string, string> = {};
vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      settings: {
        findMany: async () => Object.entries(rows).map(([key, value]) => ({ key, value })),
      },
    },
  },
}));

import { isValidStoredRegistry } from '../../server/domains/auth/oidc.service';
import { auditSettingsIntegrity } from '../../server/domains/settings/settings.integrity';
import { encryptSecret } from '../../server/domains/vault/secret/secret-crypto.service';

const VALID_PROVIDERS = JSON.stringify([
  {
    id: 'entra',
    label: 'SSO',
    issuer: 'https://login.microsoftonline.com/tenant/v2.0',
    clientId: 'client-1',
    clientSecret: 'super-secret-value',
  },
]);

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('auditSettingsIntegrity', () => {
  it('an empty settings table is ok', async () => {
    expect(await auditSettingsIntegrity()).toEqual({ ok: true, corrupt: [] });
  });

  it('every known key at a writeable value passes', async () => {
    rows.disablePasswordLogin = 'true';
    rows.run_timeout_ms = '60000';
    rows.tasks_per_agent = '32';
    rows.company_prompt = 'x'.repeat(8000);
    rows.companyName = 'A'.repeat(60);
    rows.flags = '{"tasks.turn-durations":true}';
    rows.internal_llm = JSON.stringify({ providerId: 'p', model: 'm', keySecretId: 'k' });
    rows.internal_decision = JSON.stringify({ providerId: 'p', model: 'm', keySecretId: 'k' });
    rows.oidc_providers = encryptSecret(VALID_PROVIDERS);
    expect(await auditSettingsIntegrity()).toEqual({ ok: true, corrupt: [] });
  });

  it('an unknown key with garbage passes (extensible namespace)', async () => {
    rows.some_future_key = '{broken';
    expect(await auditSettingsIntegrity()).toEqual({ ok: true, corrupt: [] });
  });

  it.each([
    ['disablePasswordLogin', 'TRUE', "expected 'true' or 'false'"],
    ['disablePasswordLogin', '1', "expected 'true' or 'false'"],
    ['run_timeout_ms', 'banana', 'expected integer 60000..21600000'],
    ['run_timeout_ms', '59999', 'expected integer 60000..21600000'],
    ['run_timeout_ms', '21600001', 'expected integer 60000..21600000'],
    ['run_timeout_ms', '1.5', 'expected integer 60000..21600000'],
    ['tasks_per_agent', '0', 'expected integer 1..32'],
    ['tasks_per_agent', '33', 'expected integer 1..32'],
    ['tasks_per_agent', 'two', 'expected integer 1..32'],
    ['company_prompt', `x`.repeat(8001), 'over the 8000-char cap'],
    ['companyName', '', 'expected 1..60 chars'],
    ['companyName', 'A'.repeat(61), 'expected 1..60 chars'],
    ['companyName', '   ', 'expected 1..60 chars'],
    ['flags', '{bad', 'invalid flags payload'],
    ['flags', '{"Bad Name":true}', 'invalid flags payload'],
    ['flags', '{"ok":1}', 'invalid flags payload'],
    ['internal_llm', 'not json', 'invalid assignment JSON'],
    ['internal_llm', '{"providerId":"p","model":"m"}', 'invalid assignment JSON'],
    ['internal_decision', '{"providerId":"p","keySecretId":"k"}', 'invalid assignment JSON'],
    ['oidc_providers', 'garbage', 'invalid OIDC registry'],
    ['oidc_providers', '[{"id":"x"}]', 'invalid OIDC registry'],
  ])('corrupt %s=%s is detected with its reason', async (key, value, reason) => {
    rows[key as string] = value as string;
    const result = await auditSettingsIntegrity();
    expect(result.ok).toBe(false);
    expect(result.corrupt).toEqual([{ key, reason }]);
  });

  it('multiple corrupt rows are all listed', async () => {
    rows.run_timeout_ms = 'nope';
    rows.flags = 'not-json';
    const result = await auditSettingsIntegrity();
    expect(result.ok).toBe(false);
    expect(result.corrupt).toEqual([
      { key: 'run_timeout_ms', reason: 'expected integer 60000..21600000' },
      { key: 'flags', reason: 'invalid flags payload' },
    ]);
  });

  it('run_timeout_ms and tasks_per_agent at their exact bounds pass', async () => {
    rows.run_timeout_ms = '21600000';
    rows.tasks_per_agent = '1';
    expect(await auditSettingsIntegrity()).toEqual({ ok: true, corrupt: [] });
  });
});

describe('isValidStoredRegistry', () => {
  it('a missing/empty registry is valid', async () => {
    expect(await isValidStoredRegistry(null)).toBe(true);
    expect(await isValidStoredRegistry('')).toBe(true);
  });

  it('a valid envelope decrypts and passes', async () => {
    expect(await isValidStoredRegistry(encryptSecret(VALID_PROVIDERS))).toBe(true);
  });

  it('a legacy plaintext registry parses as-is', async () => {
    expect(await isValidStoredRegistry('[]')).toBe(true);
    expect(await isValidStoredRegistry(VALID_PROVIDERS)).toBe(true);
  });

  it('garbage and schema-invalid payloads fail', async () => {
    expect(await isValidStoredRegistry('garbage')).toBe(false);
    expect(await isValidStoredRegistry('[{"id":"x"}]')).toBe(false);
    expect(await isValidStoredRegistry('not json at all{')).toBe(false);
  });
});
