import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
// better-auth with password login + runtime-configurable generic OIDC providers.
// The instance is a lazily-built singleton that REBUILDS when the provider set or
// password policy changes (OIDC discovery happens at build time; DB sessions survive).
//
// Env:
//   BETTER_AUTH_SECRET  — session signing (required)
//   BETTER_AUTH_URL     — canonical origin override
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { testUtils } from 'better-auth/plugins';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { ROLE, type Role } from '#shared/enums';

import { db } from '../../db/index';
import { account, user as userTable } from '../../db/schema';
import { authSchema } from '../../db/schema';
import { env as sharedEnv } from '../kernel/env';
import { getSettings } from '../settings/settings.service';
import { getOidcProviders, type OidcProvider } from './oidc.service';

const env = sharedEnv;

export type AuthPolicy = {
  oidcEnabled: boolean;
  passwordEnabled: boolean;
  oidcProviders: OidcProvider[];
};

export async function resolveAuthPolicy() {
  const s = await getSettings();
  const providers = await getOidcProviders();
  const oidcEnabled = providers.length > 0;
  const passwordEnabled = !(oidcEnabled && (s.disablePasswordLogin || env.TANDEM_DISABLE_PASSWORD_LOGIN === 'true'));
  return { passwordEnabled, oidcEnabled, oidcProviders: providers };
}

export async function anyUserExists() {
  const row = await db.query.user.findFirst({ columns: { id: true }, orderBy: { id: 'asc' } });
  return row !== undefined;
}

type Auth = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: {
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        image?: string | null;
        role?: string | null;
        mustChangePassword?: boolean;
      };
      session: { id: string; userId: string; expiresAt: Date };
    } | null>;
    createApiKey: (opts: {
      body: { name: string; userId: string; prefix?: string };
    }) => Promise<{ id: string; key: string }>;
  };
};

let instance: Auth | null = null;
let builtWith = '';

function policyKey(p: AuthPolicy) {
  // everything that feeds betterAuth() config; in-memory only, never logged
  return JSON.stringify([p.oidcProviders.map((x) => [x.id, x.issuer, x.clientId, x.clientSecret]), p.passwordEnabled]);
}

async function buildAuth(options: { includeTestUtils?: boolean } = {}) {
  const p = await resolveAuthPolicy();
  builtWith = policyKey(p);
  return betterAuth({
    // UUIDv7 for auth tables (user/session/account/verification), same as every
    // Tandem-minted id — time-ordered, index-friendly.
    advanced: { database: { generateId: () => uuidv7() } },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: authSchema,
    }),
    basePath: '/auth',
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    databaseHooks: {
      user: {
        create: {
          after: async (u) => {
            // first user claims the instance -> admin role
            /* v8 ignore start -- defensive: better-auth always passes the created user */
            if (u && typeof u === 'object' && 'id' in u) {
              const rows = await db.query.user.findMany({ columns: { id: true }, orderBy: { id: 'asc' }, limit: 2 });
              if (rows.length === 1) {
                await db
                  .update(userTable)
                  .set({ role: ROLE.ADMIN })
                  .where(eq(userTable.id, (u as { id: string }).id));
              }
            }
            /* v8 ignore stop */
          },
        },
      },
    },
    user: {
      additionalFields: {
        // union type (docs: type: ["user", "admin"]) — inferred end-to-end;
        // input:false = server-owned, users can't self-promote
        role: { type: Object.values(ROLE) as Role[], required: false, defaultValue: ROLE.VIEWER, input: false },
        // employment title rides the identity row; AI-ness is derived from
        // the ai_employees extension row, never a user column
        title: { type: 'string', required: false, defaultValue: '', input: false },
        // boot-seeded admin only (SPEC "Boot seed law") — server-owned flag,
        // cleared exclusively by changeMyPassword
        mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: p.passwordEnabled,
    },
    plugins: [
      // test-only: privileged helpers (ctx.test.login etc). NEVER enabled in the
      // production singleton — buildAuthForTest() is the only caller with the flag.
      ...(options.includeTestUtils ? [testUtils({ captureOTP: true })] : []),
      // API keys: AI employees authenticate with x-api-key; keys live in the
      // apikey table (hashed). enableSessionForAPIKeys makes
      // getSession accept them, so the oRPC middleware needs no changes.
      apiKey({
        enableSessionForAPIKeys: true,
        requireName: true,
        defaultPrefix: 'tandem_',
      }),
      ...(p.oidcProviders.length > 0
        ? [
            genericOAuth({
              config: p.oidcProviders.map((prov) => ({
                providerId: prov.id,
                name: prov.label,
                discoveryUrl: `${prov.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
                clientId: prov.clientId,
                clientSecret: prov.clientSecret,
                scopes: ['openid', 'email', 'profile'],
              })),
            }),
          ]
        : []),
    ],
    account: {
      accountLinking: accountLinkingPolicy(p.oidcProviders),
    },
  }) as unknown as Auth;
}

/**
 * Account-linking policy — SECURITY CONTRACT (SPEC "Auth", issue #127).
 *
 * Admin-configured OIDC providers are NEVER granted `trustedProviders`. In
 * better-auth's implicit linking, a trusted provider id bypasses the IdP
 * `email_verified` check, so any account on the IdP that self-asserts the email
 * of an existing verified local user (incl. the boot-seeded admin) would be
 * silently linked into it — full takeover without Tandem credentials. Linking
 * therefore proceeds only on an IdP-verified email claim, into a verified local
 * user (`requireLocalEmailVerified` default true). The providers argument is
 * deliberately accepted and ignored: this seam is the ONLY sanctioned place to
 * express linking trust, and the unit test pins that no provider id ever
 * reaches `trustedProviders`.
 */
export function accountLinkingPolicy(_providers: ReadonlyArray<{ id: string }>): {
  enabled: true;
} {
  return { enabled: true };
}

/**
 * Test-only auth instance: same database/config as production auth plus the
 * better-auth test-utils plugin (ctx.test -> factories, login(), cookie helpers).
 * Docs guidance: keep it a SEPARATE instance instead of conditionally spreading
 * the plugin, so ctx.test stays typed and no privileged helper ever ships in the
 * production singleton. Used by the e2e login helper against the e2e database.
 */
export async function buildAuthForTest() {
  return await buildAuth({ includeTestUtils: true });
}

export async function getAuth() {
  const p = await resolveAuthPolicy();
  const key = policyKey(p);
  if (!instance || builtWith !== key) {
    instance = await buildAuth();
  }
  return instance;
}

export async function rebuildAuth() {
  instance = null;
  return getAuth();
}

/**
 * ROTATION LOCK completion (SPEC "Boot seed law", #172): verify the current
 * credential, replace it, clear must_change_password — one transaction. The
 * ONLY path that clears the flag; result-union instead of throwing so the
 * router maps reasons to oRPC errors (services never import oRPC).
 */
export type ChangeMyPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'TOO_SHORT' | 'NO_CREDENTIAL' | 'WRONG_PASSWORD' };

export async function changeMyPassword(opts: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangeMyPasswordResult> {
  if (opts.newPassword.length < 8) return { ok: false, reason: 'TOO_SHORT' };
  const row = await db.query.account.findFirst({
    where: { userId: { eq: opts.userId }, providerId: { eq: 'credential' } },
    columns: { id: true, password: true },
  });
  if (!row?.password) return { ok: false, reason: 'NO_CREDENTIAL' };
  if (!(await verifyPassword({ hash: row.password, password: opts.currentPassword })))
    return { ok: false, reason: 'WRONG_PASSWORD' };
  const { hashPassword } = await import('./auth-hash.util');
  const hash = await hashPassword(opts.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(account).set({ password: hash, updatedAt: new Date() }).where(eq(account.id, row.id));
    await tx
      .update(userTable)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(userTable.id, opts.userId));
  });
  return { ok: true };
}
