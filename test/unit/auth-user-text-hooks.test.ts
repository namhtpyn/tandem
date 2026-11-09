// TEXT-STORABILITY LAW (#382, SPEC "API law"): better-auth writes `user.name`
// and `user.image` straight into Postgres text columns on BOTH its create path
// (first-user sign-up, first OIDC login) and its update-user path. The database
// hooks must refuse NUL / unpaired surrogates with the field-named BAD_REQUEST
// before the adapter sees the bytes. Pinned on the REAL built auth options — a
// deleted or unwired `before` hook turns this file red.
import { describe, expect, it, vi } from 'vitest';

// env contract: a valid vault key + secret, no real auth backend
vi.mock('../../server/domains/kernel/env', () => ({
  env: {
    TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    BETTER_AUTH_SECRET: 'unit-test-secret-unit-test-secret-unit!',
  },
}));
// no-real-DB unit law: auth.service imports the db singleton at module scope
vi.mock('../../server/db/index', () => ({ db: {} }));
vi.mock('../../server/domains/settings/settings.service', () => ({
  getSettings: async () => ({}),
}));
vi.mock('../../server/domains/auth/oidc.service', () => ({
  getOidcProviders: async () => [],
}));

import { buildAuthForTest } from '../../server/domains/auth/auth.service';

const NUL = 'A\u0000B';
const LONE = 'A\uD800B';
const ASTRAL = 'Ada 😀';

type Hook = (data: unknown) => Promise<unknown>;

async function userHooks(): Promise<Record<'create' | 'update', Hook>> {
  const auth = await buildAuthForTest();
  const options = (auth as unknown as { options: Record<string, unknown> }).options;
  const hooks = (options.databaseHooks as { user: Record<'create' | 'update', { before?: Hook }> }).user;
  const create = hooks.create.before;
  const update = hooks.update.before;
  if (!create || !update) throw new Error('a user before-hook is missing — the storability guard is unwired');
  return { create, update };
}

describe('better-auth user hooks refuse unstorable name/image (#382)', () => {
  for (const path of ['create', 'update'] as const) {
    it(`${path}: NUL and a lone surrogate answer the field-named refusal`, async () => {
      const hook = (await userHooks())[path];
      for (const field of ['name', 'image'] as const) {
        for (const bad of [NUL, LONE]) {
          const error = await hook({ [field]: bad }).catch((e: unknown) => e as { message?: string });
          expect(String((error as { message?: string }).message), `${path}.${field}`).toContain(
            `${field} contains invalid characters (NUL or a lone surrogate)`,
          );
        }
      }
    });

    it(`${path}: a well-formed astral value passes`, async () => {
      const hook = (await userHooks())[path];
      // better-auth cancels the write when a before hook returns `false`, so
      // "resolved" alone is not acceptance; a hook may also return `{ data }`
      // with normalized values, which must keep the astral text intact
      const result = await hook({ name: ASTRAL, image: 'data:image/png;base64,AAAA' });
      expect(result).not.toBe(false);
      if (result && typeof result === 'object' && 'data' in result) {
        expect((result as { data: { name?: string } }).data.name).toContain(ASTRAL);
      }
    });
  }
});
