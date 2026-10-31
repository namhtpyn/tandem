import { describe, expect, it, vi } from 'vitest';

// env contract: valid vault key (kernel env throws otherwise), no auth secrets
// needed — this suite never builds the auth instance.
vi.mock('../../server/domains/kernel/env', () => ({
  env: {
    TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    BETTER_AUTH_SECRET: 'unit-test-secret-unit-test-secret-unit!',
  },
}));

// no-real-DB unit law: auth.service imports the db singleton at module scope.
vi.mock('../../server/db/index', () => ({ db: {} }));
vi.mock('../../server/domains/settings/settings.service', () => ({
  getSettings: async () => ({}),
}));
vi.mock('../../server/domains/auth/oidc.service', () => ({
  getOidcProviders: async () => [],
}));

import { accountLinkingPolicy } from '../../server/domains/auth/auth.service';

// SECURITY CONTRACT (SPEC "Auth", issue #127): implicit account linking must
// never trust admin-configured provider ids. better-auth links implicitly when
// `trustedProviders` contains the provider id OR the IdP asserts a verified
// email claim — granting provider ids bypasses the email_verified gate, so any
// identity on the IdP that self-asserts an existing verified local user's email
// (incl. the boot-seeded admin) would take that account over. This test pins
// the ONLY sanctioned seam (`accountLinkingPolicy`): no provider configuration,
// however large, may ever produce a `trustedProviders` grant.
describe('accountLinkingPolicy', () => {
  it('grants no trustedProviders with zero providers configured', () => {
    const policy = accountLinkingPolicy([]);
    expect(policy).toEqual({ enabled: true });
    expect(Object.keys(policy)).not.toContain('trustedProviders');
  });

  it('grants no trustedProviders regardless of how many providers are configured', () => {
    const providers = [{ id: 'keycloak' }, { id: 'authentik' }, { id: 'entraid' }, { id: 'attacker-controlled' }];
    const policy = accountLinkingPolicy(providers);
    const blob = JSON.stringify(policy);
    expect('trustedProviders' in policy).toBe(false);
    for (const p of providers) {
      expect(blob).not.toContain(p.id);
    }
    expect(policy).toEqual({ enabled: true });
  });

  it('stays enabled so verified-claim linking keeps working', () => {
    // The contract closes the takeover path WITHOUT disabling linking: an IdP
    // that asserts email_verified for a verified local user still links.
    expect(accountLinkingPolicy([{ id: 'x' }]).enabled).toBe(true);
  });
});
