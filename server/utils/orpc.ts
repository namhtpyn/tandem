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
