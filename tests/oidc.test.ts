// OIDC registry: storage round-trip, env fallback, validation failures
import { describe, expect, it, beforeEach } from 'vitest';

import './helpers/pg';
import { applyMigrations } from '../server/db/index';
import { getOidcProviders, saveOidcProviders } from '../server/domains/auth/oidc.service';
import { resetSchema } from './helpers/pg';
import { env, setEnv } from '../server/domains/kernel/env';

describe('oidc registry', () => {
  beforeEach(async () => {
    await resetSchema();
    await applyMigrations();
  });

  it('is empty when nothing stored and no env', async () => {
    setEnv({ TANDEM_OIDC_ISSUER: undefined });
    expect(await getOidcProviders()).toEqual([]);
  });

  it('falls back to env provider when nothing stored', async () => {
    setEnv({ TANDEM_OIDC_ISSUER: 'https://env.example.com' });
    setEnv({ TANDEM_OIDC_CLIENT_ID: 'env-client' });
    setEnv({ TANDEM_OIDC_CLIENT_SECRET: 'env-secret' });
    setEnv({ TANDEM_OIDC_LABEL: 'EnvSSO' });
    try {
      const providers = await getOidcProviders();
      expect(providers).toEqual([
        {
          id: 'oidc',
          label: 'EnvSSO',
          issuer: 'https://env.example.com',
          clientId: 'env-client',
          clientSecret: 'env-secret',
        },
      ]);
    } finally {
      setEnv({ TANDEM_OIDC_ISSUER: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_ID: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_SECRET: undefined });
      setEnv({ TANDEM_OIDC_LABEL: undefined });
    }
  });

  it('save + get round-trips providers (stored wins over env)', async () => {
    await saveOidcProviders([
      {
        id: 'p1',
        label: 'One',
        issuer: 'https://one.example.com',
        clientId: 'c1',
        clientSecret: 's1',
      },
    ]);
    setEnv({ TANDEM_OIDC_ISSUER: 'https://env.example.com' });
    setEnv({ TANDEM_OIDC_CLIENT_ID: 'env-client' });
    setEnv({ TANDEM_OIDC_CLIENT_SECRET: 'env-secret' });
    try {
      const providers = await getOidcProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]!.id).toBe('p1');
    } finally {
      setEnv({ TANDEM_OIDC_ISSUER: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_ID: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_SECRET: undefined });
    }
  });

  it('ignores a corrupted stored registry and falls through to env', async () => {
    const { setSetting } = await import('../server/domains/settings/settings.service');
    await setSetting('oidc_providers', 'not json {{{');
    setEnv({ TANDEM_OIDC_ISSUER: 'https://env.example.com' });
    setEnv({ TANDEM_OIDC_CLIENT_ID: 'env-client' });
    setEnv({ TANDEM_OIDC_CLIENT_SECRET: 'env-secret' });
    try {
      const providers = await getOidcProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]!.issuer).toBe('https://env.example.com');
    } finally {
      setEnv({ TANDEM_OIDC_ISSUER: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_ID: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_SECRET: undefined });
    }
  });

  it('ignores a stored registry failing schema validation', async () => {
    const { setSetting } = await import('../server/domains/settings/settings.service');
    // valid JSON, but issuer is not a URL
    await setSetting(
      'oidc_providers',
      JSON.stringify([{ id: 'x', label: 'X', issuer: 'nope', clientId: 'c', clientSecret: 's' }]),
    );
    expect(await getOidcProviders()).toEqual([]);
  });
});
