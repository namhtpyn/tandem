// better-auth with password login + runtime-configurable generic OIDC providers.
// The instance is a lazily-built singleton that REBUILDS when the provider set or
// password policy changes (OIDC discovery happens at build time; DB sessions survive).
//
// Env:
//   BETTER_AUTH_SECRET  — session signing (required)
//   BETTER_AUTH_URL     — canonical origin override
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { apiKey } from '@better-auth/api-key'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { user as userTable } from '../db/schema'
import { authSchema } from '../db/schema'
import { getSettings } from './settings'
import { getOidcProviders, type OidcProvider } from './oidc'

const env = process.env

export interface AuthPolicy {
  oidcEnabled: boolean
  passwordEnabled: boolean
  oidcProviders: OidcProvider[]
}

export async function resolveAuthPolicy(): Promise<AuthPolicy> {
  const s = await getSettings()
  const providers = await getOidcProviders()
  const oidcEnabled = providers.length > 0
  const passwordEnabled = !(oidcEnabled && (s.disablePasswordLogin || env.TANDEM_DISABLE_PASSWORD_LOGIN === 'true'))
  return { passwordEnabled, oidcEnabled, oidcProviders: providers }
}

export async function anyUserExists(): Promise<boolean> {
  const rows = await db.select({ id: userTable.id }).from(userTable).limit(1)
  return rows.length > 0
}

interface Auth {
  handler: (request: Request) => Promise<Response>
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{
      user: { id: string, name: string, email: string, emailVerified: boolean, image?: string | null, role?: string | null }
      session: { id: string, userId: string, expiresAt: Date }
    } | null>
    createApiKey: (opts: { body: { name: string, userId: string, prefix?: string } }) => Promise<{ id: string, key: string }>
  }
}

let instance: Auth | null = null
let builtWith = ''

function policyKey(p: AuthPolicy): string {
  // everything that feeds betterAuth() config; in-memory only, never logged
  return JSON.stringify([p.oidcProviders.map(x => [x.id, x.issuer, x.clientId, x.clientSecret]), p.passwordEnabled])
}

async function buildAuth(): Promise<Auth> {
  const p = await resolveAuthPolicy()
  builtWith = policyKey(p)
  return betterAuth({
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
              const rows = await db.select({ id: userTable.id }).from(userTable).limit(2)
              if (rows.length === 1) {
                await db.update(userTable).set({ role: 'admin' }).where(eq(userTable.id, (u as { id: string }).id))
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
        role: { type: ['admin', 'employee', 'viewer'] as const, required: false, defaultValue: 'viewer', input: false },
        // employment title rides the identity row; AI-ness is derived from
        // the tandem_ai_employees extension row, never a user column
        title: { type: 'string', required: false, defaultValue: '', input: false },
      },
    },
    emailAndPassword: {
      enabled: p.passwordEnabled,
    },
    plugins: [
      // API keys: AI employees authenticate with x-api-key; keys live in the
      // tandem_apikey table (hashed). enableSessionForAPIKeys makes
      // getSession accept them, so the oRPC middleware needs no changes.
      apiKey({
        enableSessionForAPIKeys: true,
        requireName: true,
        defaultPrefix: 'tandem_',
      }),
      ...(p.oidcProviders.length > 0
        ? [
            genericOAuth({
              config: p.oidcProviders.map(prov => ({
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
      accountLinking: {
        // generic-oauth providers are configured by the instance admin, so they
        // are trusted to link by email (custom providers are not in better-auth's
        // builtin trusted list; without this, auto-linking requires an
        // email_verified claim the IdP may not send)
        trustedProviders: p.oidcProviders.map(x => x.id),
      },
    },
  }) as unknown as Auth
}

export async function getAuth(): Promise<Auth> {
  const p = await resolveAuthPolicy()
  const key = policyKey(p)
  if (!instance || builtWith !== key) {
    instance = await buildAuth()
  }
  return instance
}

export async function rebuildAuth(): Promise<Auth> {
  instance = null
  return getAuth()
}
