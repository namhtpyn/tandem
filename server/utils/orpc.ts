// oRPC v2 server: router mounted at /rpc (Fetch API adapter). Better Auth
// sessions resolved lazily per request from reqHeaders (official integration
// pattern); live queries re-emit snapshots from the change bus over SSE.
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ORPCError, os } from '@orpc/server'
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins'
import { db } from '../db'
import { environments as environmentsTable } from '../db/schema'
import { environmentInput } from './environments'
import { probeSsh } from './ssh-probe'
import { changeBus, publishChange, type ChangeEvent, type ChangeResource } from './change-bus'
import type { EnvironmentRow } from '../../shared/types'

export interface ServerContext extends RequestHeadersHandlerPluginContext {
  getSession: () => Promise<{ user: { id: string, name: string, email: string, role: string } } | null>
}

const base = os.$context<ServerContext>()

// Lazily resolve the better-auth session at most once per request; every
// sub-request in a batch shares the getter.
const requireSession = base.middleware(async ({ context, next }) => {
  const session = await context.getSession()
  if (!session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' })
  }
  return next({ context: { session } })
})

const protectedProcedure = base.use(requireSession)

/** Live generator: initial snapshot, then fresh snapshots on relevant changes. */
async function* liveGenerator<T>(resources: ChangeResource[], fetch: () => Promise<T>) {
  yield await fetch()
  for await (const evt of changeBus.subscribe('change')) {
    if (resources.includes(evt.resource)) {
      yield await fetch()
    }
  }
}

function toRow(r: typeof environmentsTable.$inferSelect): EnvironmentRow {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.select().from(environmentsTable).orderBy(desc(environmentsTable.createdAt))
  return rows.map(toRow)
}

export const router = os.router({
  meta: {
    /** version — public */
    version: base.handler(() => ({ version: process.env.APP_VERSION || 'dev' })),
  },

  auth: {
    /** public auth capabilities for the login screen (live) */
    configLive: base.handler(() => liveGenerator(['settings', 'oidc'], async () => {
      const { resolveAuthPolicy } = await import('./auth')
      const p = await resolveAuthPolicy()
      return {
        passwordEnabled: p.passwordEnabled,
        oidcEnabled: p.oidcEnabled,
        providers: p.oidcProviders.map(x => ({ id: x.id, label: x.label })),
      }
    })),

    /** current session (null when anonymous) */
    session: base.handler(async ({ context }) => {
      const session = await context.getSession()
      return session
    }),
  },

  settings: {
    /** live app settings */
    live: protectedProcedure.handler(() => liveGenerator(['settings'], async () => {
      const { getSettings } = await import('./settings')
      return await getSettings()
    })),

    /** update settings (strict input) */
    update: protectedProcedure
      .input(z.strictObject({ disablePasswordLogin: z.boolean().optional() }))
      .handler(async ({ input }) => {
        const { setSetting } = await import('./settings')
        const { rebuildAuth } = await import('./auth')
        const { getOidcProviders } = await import('./oidc')
        if (input.disablePasswordLogin === true) {
          const providers = await getOidcProviders()
          if (providers.length === 0) {
            throw new ORPCError('BAD_REQUEST', { message: 'configure an OIDC provider before disabling password login' })
          }
        }
        if (input.disablePasswordLogin !== undefined) {
          await setSetting('disablePasswordLogin', input.disablePasswordLogin ? 'true' : 'false')
        }
        await rebuildAuth()
        await publishChange('settings', 'update')
        return { ok: true }
      }),
  },

  oidc: {
    /** live provider list (secrets never leave the server) */
    live: protectedProcedure.handler(() => liveGenerator(['oidc'], async () => {
      const { getOidcProviders } = await import('./oidc')
      const providers = await getOidcProviders()
      return providers.map(p => ({
        id: p.id,
        label: p.label,
        issuer: p.issuer,
        clientId: p.clientId,
        hasSecret: p.clientSecret.length > 0,
      }))
    })),

    /** replace the provider registry (secrets write-only) */
    replace: protectedProcedure
      .input(z.strictObject({
        providers: z.array(z.strictObject({
          id: z.string().min(1).max(64).optional(),
          label: z.string().min(1).max(64),
          issuer: z.string().url(),
          clientId: z.string().min(1).max(200),
          clientSecret: z.string().max(400).optional(),
        })).max(10),
      }))
      .handler(async ({ input }) => {
        const { getOidcProviders, saveOidcProviders, oidcProviderSchema } = await import('./oidc')
        const { rebuildAuth } = await import('./auth')
        const existing = await getOidcProviders()
        const result = []
        for (const p of input.providers) {
          const secret = p.clientSecret && p.clientSecret.length > 0
            ? p.clientSecret
            : existing.find(x => x.id === p.id)?.clientSecret
          if (!secret) {
            throw new ORPCError('BAD_REQUEST', { message: `provider ${p.label}: clientSecret is required for new providers` })
          }
          const id = p.id && existing.some(x => x.id === p.id)
            ? p.id
            : crypto.randomUUID()
          result.push(oidcProviderSchema.parse({ id, label: p.label, issuer: p.issuer, clientId: p.clientId, clientSecret: secret }))
        }
        await saveOidcProviders(result)
        await rebuildAuth()
        await publishChange('oidc', 'update')
        return { ok: true, count: result.length }
      }),
  },

  environments: {
    /** live list — pushes a fresh snapshot on every environments change */
    live: protectedProcedure.handler(() => liveGenerator(['environments'], listEnvironments)),

    create: protectedProcedure
      .input(environmentInput)
      .handler(async ({ input }) => {
        const clash = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.name, input.name))
        if (clash.length > 0) {
          throw new ORPCError('CONFLICT', { message: `environment "${input.name}" already exists` })
        }
        const inserted = await db.insert(environmentsTable).values({ id: crypto.randomUUID(), ...input }).returning()
        await publishChange('environments', 'create')
        return toRow(inserted[0]!)
      }),

    update: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1), ...environmentInput.shape }))
      .handler(async ({ input }) => {
        const { id, ...data } = input
        const clash = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.name, data.name))
        if (clash.some((c: { id: string }) => c.id !== id)) {
          throw new ORPCError('CONFLICT', { message: `environment "${data.name}" already exists` })
        }
        const updated = await db.update(environmentsTable).set({ ...data, updatedAt: new Date() }).where(eq(environmentsTable.id, id)).returning()
        if (updated.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
        }
        await publishChange('environments', 'update')
        return toRow(updated[0]!)
      }),

    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const deleted = await db.delete(environmentsTable).where(eq(environmentsTable.id, input.id)).returning({ id: environmentsTable.id })
        if (deleted.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
        }
        await publishChange('environments', 'delete')
        return { ok: true }
      }),

    probe: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const rows = await db.select().from(environmentsTable).where(eq(environmentsTable.id, input.id))
        const env = rows[0]
        if (!env) {
          throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
        }
        const started = Date.now()
        const result = await probeSsh(env.host, env.port, env.username)
        return { ...result, durationMs: Date.now() - started }
      }),
  },
})

interface AuthSessionPayload {
  user: { id: string, name: string, email: string, role: string }
}

export function buildServerContext(headers: Headers | undefined): ServerContext {
  let cached: AuthSessionPayload | null = null
  let resolved = false
  return {
    reqHeaders: headers,
    getSession: async (): Promise<AuthSessionPayload | null> => {
      if (resolved) return cached
      resolved = true
      const { getAuth } = await import('./auth')
      const auth = await getAuth()
      const session = await auth.api.getSession({ headers: headers ?? new Headers() })
      if (!session) {
        cached = null
        return null
      }
      cached = {
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role: session.user.role ?? 'viewer',
        },
      }
      return cached
    },
  }
}

export type ChangeBusEvent = ChangeEvent
