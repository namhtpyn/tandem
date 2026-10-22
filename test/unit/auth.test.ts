// auth: policy resolution, instance caching/rebuild, admin seed path
import { describe, expect, it, beforeEach } from 'vitest';

import './helpers/pg';
import { applyMigrations } from '../../server/db/index';
import { db } from '../../server/db/index';
import { user, account } from '../../server/db/schema';
import { hashPassword } from '../../server/domains/auth/auth-hash.util';
import { resolveAuthPolicy, anyUserExists, getAuth, rebuildAuth } from '../../server/domains/auth/auth.service';
import { saveOidcProviders } from '../../server/domains/auth/oidc.service';
import { env, setEnv } from '../../server/domains/kernel/env';
import { setSetting } from '../../server/domains/settings/settings.service';
import { ROLE } from '../../shared/enums';
import { resetSchema } from './helpers/pg';

describe('auth policy', () => {
  beforeEach(async () => {
    await resetSchema();
    await applyMigrations();
    setEnv({ TANDEM_DISABLE_PASSWORD_LOGIN: undefined });
    await saveOidcProviders([]);
  });

  it('password-only when no providers configured', async () => {
    const p = await resolveAuthPolicy();
    expect(p.passwordEnabled).toBe(true);
    expect(p.oidcEnabled).toBe(false);
    expect(p.oidcProviders).toEqual([]);
  });

  it('oidc enabled when a provider is stored', async () => {
    await saveOidcProviders([
      {
        id: 'p1',
        label: 'One',
        issuer: 'https://one.example.com',
        clientId: 'c',
        clientSecret: 's',
      },
    ]);
    const p = await resolveAuthPolicy();
    expect(p.oidcEnabled).toBe(true);
    expect(p.passwordEnabled).toBe(true);
  });

  it('password disabled when policy set AND provider exists', async () => {
    await saveOidcProviders([
      {
        id: 'p1',
        label: 'One',
        issuer: 'https://one.example.com',
        clientId: 'c',
        clientSecret: 's',
      },
    ]);
    await setSetting('disablePasswordLogin', 'true');
    const p = await resolveAuthPolicy();
    expect(p.passwordEnabled).toBe(false);
  });

  it('env TANDEM_DISABLE_PASSWORD_LOGIN respected with env provider', async () => {
    const { deleteSetting } = await import('../../server/domains/settings/settings.service');
    await deleteSetting('oidc_providers');
    setEnv({ TANDEM_OIDC_ISSUER: 'https://env.example.com' });
    setEnv({ TANDEM_OIDC_CLIENT_ID: 'env-client' });
    setEnv({ TANDEM_OIDC_CLIENT_SECRET: 'env-secret' });
    setEnv({ TANDEM_DISABLE_PASSWORD_LOGIN: 'true' });
    try {
      const p = await resolveAuthPolicy();
      expect(p.passwordEnabled).toBe(false);
      expect(p.oidcEnabled).toBe(true);
    } finally {
      setEnv({ TANDEM_OIDC_ISSUER: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_ID: undefined });
      setEnv({ TANDEM_OIDC_CLIENT_SECRET: undefined });
      setEnv({ TANDEM_DISABLE_PASSWORD_LOGIN: undefined });
    }
  });
});

describe('auth instance', () => {
  beforeEach(async () => {
    await resetSchema();
    await applyMigrations();
    await saveOidcProviders([]);
  });

  it('builds and caches; rebuild swaps when policy changes', async () => {
    const a = await getAuth();
    const b = await getAuth();
    expect(a).toBe(b); // cached
    await rebuildAuth();
    const c = await getAuth();
    expect(c).not.toBe(a); // rebuilt
  });

  it('rebuilds implicitly when the provider set changes', async () => {
    const a = await getAuth();
    await saveOidcProviders([
      {
        id: 'p1',
        label: 'One',
        issuer: 'https://one.example.com',
        clientId: 'c',
        clientSecret: 's',
      },
    ]);
    const b = await getAuth();
    expect(b).not.toBe(a);
  });

  it('anyUserExists tracks the user table', async () => {
    expect(await anyUserExists()).toBe(false);
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-c5ea71554c77',
      name: 'U',
      email: 'u@x.co',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: ROLE.VIEWER,
    });
    expect(await anyUserExists()).toBe(true);
  });
});

describe('hashPassword (better-auth compatible)', () => {
  it('produces a scrypt string better-auth verifies', async () => {
    const hash = await hashPassword('secret-pw');
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    // round-trip through better-auth's verifier
    const { verifyPassword } = await import('better-auth/crypto');
    expect(await verifyPassword({ hash, password: 'secret-pw' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
  });
});

describe('auth baseURL env branch', () => {
  it('honors BETTER_AUTH_URL when set', async () => {
    setEnv({ BETTER_AUTH_URL: 'https://auth.example.com' });
    try {
      await rebuildAuth();
      const { getAuth } = await import('../../server/domains/auth/auth.service');
      const auth = await getAuth();
      expect((auth.options as { baseURL?: string }).baseURL).toBe('https://auth.example.com');
    } finally {
      setEnv({ BETTER_AUTH_URL: undefined });
      await rebuildAuth();
    }
  });
});
