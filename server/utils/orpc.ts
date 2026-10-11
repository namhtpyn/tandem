// oRPC v2 server: router mounted at /rpc (Fetch API adapter). Better Auth
// sessions resolved lazily per request from reqHeaders (official integration
// pattern); live queries re-emit snapshots from the change bus over SSE.
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ORPCError, os } from '@orpc/server'
import type { RequestHeadersHandlerPluginContext } from '@orpc/server/plugins'
import { db } from '../db'
import { aiEmployees as aiEmployeesTable, apikey as apikeyTable, employeeSupervisors as supervisorsTable, environments as environmentsTable, models as modelsTable, modelProviders as modelProvidersTable, tasks as tasksTable, user as userTable, vaultSecrets as vaultSecretsTable, vaultAudit as vaultAuditTable } from '../db/schema'
import { environmentInput } from './environments'
import { probeSsh } from './ssh-probe'
import { changeBus, publishChange, type ChangeEvent, type ChangeResource } from './change-bus'
import { decryptSecret, encryptSecret, lastFourHint } from './vault-crypto'
import type { ApiKeyRow, EmployeeRow, EnvironmentRow, TaskRow, VaultAuditRow, VaultSecretRow } from '../../shared/types'

export interface ServerContext extends RequestHeadersHandlerPluginContext {
  getSession: () => Promise<{ user: { id: string, name: string, email: string, role: 'admin' | 'employee' | 'viewer' } } | null>
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
    secretId: r.secretId,
    secretUsage: r.secretUsage as 'ssh-key' | 'password',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function toVaultRow(r: typeof vaultSecretsTable.$inferSelect): VaultSecretRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    lastFour: r.lastFour,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

async function listVaultSecrets(): Promise<VaultSecretRow[]> {
  const rows = await db.select().from(vaultSecretsTable).orderBy(desc(vaultSecretsTable.createdAt))
  return rows.map(toVaultRow)
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
      const { getSettings } = await import('./settings')
      const [p, s] = await Promise.all([resolveAuthPolicy(), getSettings()])
      return {
        passwordEnabled: p.passwordEnabled,
        oidcEnabled: p.oidcEnabled,
        providers: p.oidcProviders.map(x => ({ id: x.id, label: x.label })),
        companyName: s.companyName,
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
      .input(z.strictObject({ disablePasswordLogin: z.boolean().optional(), companyName: z.string().min(1).max(60).optional() }))
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
        if (input.companyName !== undefined) {
          await setSetting('companyName', input.companyName.trim())
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


  providers: {
    /** live model-provider catalog with model names */
    live: protectedProcedure.handler(() => liveGenerator(['providers'], async () => {
      const { listModelProviders } = await import('./model-providers')
      return await listModelProviders()
    })),

    /** replace ONE provider (upsert by id) with its model list */
    save: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1).max(64).optional(),
        label: z.string().min(1).max(64),
        baseUrl: z.string().url(),
        apiStyle: z.enum(['openai', 'anthropic']),
        extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
        notes: z.string().max(500).optional(),
        modelNames: z.array(z.string().min(1).max(200)).max(100).default([]),
      }))
      .handler(async ({ input }) => {
        const { modelProviderInputSchema } = await import('./model-providers')
        modelProviderInputSchema.parse(input)
        const id = input.id?.trim() || crypto.randomUUID()
        const now = new Date()
        const values = {
          id,
          label: input.label,
          baseUrl: input.baseUrl,
          apiStyle: input.apiStyle,
          extraHeaders: input.extraHeaders ? JSON.stringify(input.extraHeaders) : null,
          notes: input.notes ?? null,
          updatedAt: now,
        }
        await db.insert(modelProvidersTable).values(values)
          .onConflictDoUpdate({ target: modelProvidersTable.id, set: { label: values.label, baseUrl: values.baseUrl, apiStyle: values.apiStyle, extraHeaders: values.extraHeaders, notes: values.notes, updatedAt: now } })
        // model list = full replace for this provider
        await db.delete(modelsTable).where(eq(modelsTable.providerId, id))
        const names = [...new Set(input.modelNames)]
        if (names.length > 0) {
          await db.insert(modelsTable).values(names.map(n => ({ id: crypto.randomUUID(), providerId: id, name: n })))
        }
        await publishChange('providers', 'update')
        return { id }
      }),

    /** fetch the live model catalog from a provider endpoint.
     *  Key is TRANSIENT — used for this one request, never stored or logged. */
    fetchModels: protectedProcedure
      .input(z.strictObject({
        baseUrl: z.string().url(),
        apiStyle: z.enum(['openai', 'anthropic']),
        key: z.string().min(1).max(400).optional(),
        extraHeaders: z.record(z.string().min(1), z.string().max(500)).optional(),
      }))
      .handler(async ({ input }): Promise<{ models: string[] }> => {
        const url = input.apiStyle === 'anthropic'
          ? `${input.baseUrl.replace(/\/$/, '')}/v1/models`
          : `${input.baseUrl.replace(/\/$/, '')}/models`
        const headers: Record<string, string> = { ...input.extraHeaders }
        if (input.key) {
          if (input.apiStyle === 'anthropic') {
            headers['x-api-key'] = input.key
            headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
          }
          else {
            headers.Authorization = `Bearer ${input.key}`
          }
        }
        // fetch pages (Anthropic paginates with has_more + last_id; OpenAI-style returns one page)
        const models: string[] = []
        let after: string | null = null
        for (let page = 0; page < 10; page++) {
          const paged = after ? `${url}?after_id=${encodeURIComponent(after)}&limit=100` : `${url}?limit=100`
          let body: unknown
          try {
            const res = await fetch(paged, { headers, signal: AbortSignal.timeout(10_000) })
            if (!res.ok) {
              throw new ORPCError('BAD_REQUEST', { message: `endpoint returned ${res.status}` })
            }
            body = await res.json()
          }
          catch (e) {
            if (e instanceof ORPCError) throw e
            throw new ORPCError('BAD_REQUEST', { message: 'could not reach the endpoint' })
          }
          const payload = body as { data?: Array<{ id?: string }>, has_more?: boolean, last_id?: string | null }
          const list = payload?.data
          if (Array.isArray(list)) {
            models.push(...list.map(m => m.id).filter((m): m is string => typeof m === 'string' && m.length > 0))
          }
          if (!payload?.has_more || !payload?.last_id) break
          after = payload.last_id
        }
        return { models: [...new Set(models)].sort() }
      }),

    /** delete a provider (blocked while AI employees use it) */
    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const { providerInUse } = await import('./model-providers')
        if (await providerInUse(input.id)) {
          throw new ORPCError('BAD_REQUEST', { message: 'provider is in use by AI employees' })
        }
        await db.delete(modelProvidersTable).where(eq(modelProvidersTable.id, input.id))
        await publishChange('providers', 'update')
        return { ok: true }
      }),
  },

  tasks: {
    /** live list — tasks with assignee info, newest first */
    live: protectedProcedure.handler(() => liveGenerator(['tasks'], async (): Promise<TaskRow[]> => {
      const rows = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt))
      const users = await db.select({ id: userTable.id, name: userTable.name }).from(userTable)
      const aiRows = await db.select({ userId: aiEmployeesTable.userId }).from(aiEmployeesTable)
      const aiIds = new Set(aiRows.map(r => r.userId))
      const nameById = new Map(users.map(u => [u.id, u.name]))
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status as 'todo' | 'doing' | 'done',
        assigneeId: r.assigneeId,
        assigneeName: (r.assigneeId && nameById.get(r.assigneeId)) || null,
        assigneeKind: r.assigneeId ? (aiIds.has(r.assigneeId) ? 'ai' : 'human') : null,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }))
    })),

    /** create a task */
    create: protectedProcedure
      .input(z.strictObject({
        title: z.string().min(1).max(200),
        description: z.string().max(10_000).optional(),
        assigneeId: z.string().min(1).nullable().optional(),
      }))
      .handler(async ({ input, context }) => {
        if (input.assigneeId) {
          const u = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, input.assigneeId))
          if (u.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'assignee does not exist' })
        }
        const selfId = (context as { session?: { user?: { id?: string } } }).session?.user?.id ?? null
        const id = crypto.randomUUID()
        await db.insert(tasksTable).values({
          id,
          title: input.title,
          description: input.description ?? '',
          status: 'todo',
          assigneeId: input.assigneeId ?? null,
          createdBy: selfId,
        })
        await publishChange('tasks', 'create')
        return { id }
      }),

    /** update a task (title/description/status/assignee) */
    update: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(10_000).nullable().optional(),
        status: z.enum(['todo', 'doing', 'done']).optional(),
        assigneeId: z.string().min(1).nullable().optional(),
      }))
      .handler(async ({ input }) => {
        const rows = await db.select().from(tasksTable).where(eq(tasksTable.id, input.id))
        if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' })
        if (input.assigneeId) {
          const u = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, input.assigneeId))
          if (u.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'assignee does not exist' })
        }
        const patch: Record<string, unknown> = { updatedAt: new Date() }
        if (input.title !== undefined) patch.title = input.title
        if (input.description !== undefined && input.description !== null) patch.description = input.description
        if (input.status !== undefined) patch.status = input.status
        if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId
        await db.update(tasksTable).set(patch).where(eq(tasksTable.id, input.id))
        await publishChange('tasks', 'update')
        return { ok: true }
      }),

    /** delete a task */
    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const rows = await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, input.id))
        if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' })
        await db.delete(tasksTable).where(eq(tasksTable.id, input.id))
        await publishChange('tasks', 'delete')
        return { ok: true }
      }),
  },

  employees: {
    /** live list — every employee with supervisors + AI extension, one snapshot */
    live: protectedProcedure.handler(() => liveGenerator(['employees'], async () => {
      const rows = await db.select().from(userTable).orderBy(userTable.createdAt)
      const supRows = await db.select().from(supervisorsTable)
      const aiRows = await db.select().from(aiEmployeesTable)
      const sups = new Map<string, string[]>()
      for (const s of supRows) {
        ;(sups.get(s.employeeId) ?? sups.set(s.employeeId, []).get(s.employeeId)!).push(s.supervisorId)
      }
      const aiByUser = new Map(aiRows.map(r => [r.userId, r]))
      return rows.map((r): EmployeeRow => {
        const ai = aiByUser.get(r.id)
        return {
          id: r.id,
          userId: r.id,
          name: r.name,
          email: r.email,
          // derived: extension row present => ai, absent => human
          kind: ai ? 'ai' : 'human',
          title: r.title,
          supervisorIds: sups.get(r.id) ?? [],
          environmentId: ai?.environmentId ?? null,
          harness: ai?.harness ?? null,
          executable: ai?.executable ?? null,
          providerId: ai?.providerId ?? null,
          modelId: ai?.modelId ?? null,
          apiKeySecretId: ai?.apiKeySecretId ?? null,
          instructions: ai?.instructions ?? null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }
      })
    })),

    /** create an employee AND its login user. kind=ai also mints an API key
     *  (returned once) and the AI extension row. */
    create: protectedProcedure
      .input(z.strictObject({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        kind: z.enum(['human', 'ai']),
        title: z.string().min(1).max(100),
        supervisorIds: z.array(z.string().min(1)).max(20).default([]),
        environmentId: z.string().min(1).optional(),
        instructions: z.string().max(10_000).optional(),
        harness: z.enum(['hermes']).optional(),
        executable: z.string().min(1).max(60).optional(),
        providerId: z.string().min(1).nullable().optional(),
        modelId: z.string().min(1).nullable().optional(),
        apiKeySecretId: z.string().min(1).nullable().optional(),
      }))
      .handler(async ({ input, context }) => {
        // AI employees REQUIRE an environment
        if (input.kind === 'ai' && !input.environmentId) {
          throw new ORPCError('BAD_REQUEST', { message: 'AI employees need an environment' })
        }
        if (input.kind === 'human' && (input.environmentId !== undefined || input.instructions !== undefined || input.harness !== undefined || input.executable !== undefined)) {
          throw new ORPCError('BAD_REQUEST', { message: 'environment/instructions/harness/executable apply to AI employees only' })
        }
        // supervisors must exist and not include a duplicate (default fills [])
        const supervisorIds = input.supervisorIds ?? []
        if (new Set(supervisorIds).size !== supervisorIds.length) {
          throw new ORPCError('BAD_REQUEST', { message: 'duplicate supervisor ids' })
        }
        if (supervisorIds.length > 0) {
          const found = await db.select({ id: userTable.id }).from(userTable)
          const ids = new Set(found.map(f => f.id))
          for (const s of supervisorIds) {
            if (!ids.has(s)) {
              throw new ORPCError('BAD_REQUEST', { message: `supervisor ${s} does not exist` })
            }
          }
        }
        // environment must exist for AI
        if (input.environmentId) {
          const env = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.id, input.environmentId))
          if (env.length === 0) {
            throw new ORPCError('BAD_REQUEST', { message: 'environment does not exist' })
          }
        }
        // email must be free
        const clash = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, input.email))
        if (clash.length > 0) {
          throw new ORPCError('CONFLICT', { message: `user ${input.email} already exists` })
        }
        // user IS the employee: one row carries identity + employment.
        // AI-ness = extension row, never a column.
        const userId = crypto.randomUUID()
        await db.insert(userTable).values({ id: userId, name: input.name, email: input.email, role: 'employee', title: input.title })
        if (supervisorIds.length > 0) {
          await db.insert(supervisorsTable).values(supervisorIds.map(s => ({ employeeId: userId, supervisorId: s })))
        }
        let apiKey: string | undefined
        if (input.kind === 'ai') {
          if (input.apiKeySecretId) {
            const sec = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.apiKeySecretId))
            if (sec.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'api key secret not found' })
          }
          if (input.providerId) {
            const prov = await db.select({ id: modelProvidersTable.id }).from(modelProvidersTable).where(eq(modelProvidersTable.id, input.providerId))
            if (prov.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'provider does not exist' })
          }
          if (input.modelId) {
            const m = await db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.id, input.modelId))
            if (m.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'model does not exist' })
          }
          await db.insert(aiEmployeesTable).values({
            userId,
            environmentId: input.environmentId!,
            instructions: input.instructions ?? '',
            harness: input.harness ?? 'hermes',
            executable: input.executable?.trim() || 'hermes',
            providerId: input.providerId ?? null,
            modelId: input.modelId ?? null,
            apiKeySecretId: input.apiKeySecretId ?? null,
          })
          const { getAuth } = await import('./auth')
          const auth = await getAuth()
          const created = await auth.api.createApiKey({ body: { name: `${input.name.slice(0, 40)} ai-key`, userId, prefix: 'tandem_' } })
          apiKey = created.key
        }
        await publishChange('employees', 'create')
        return { id: userId, userId, apiKey }
      }),

    update: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1).max(100),
        email: z.string().email().optional(),
        title: z.string().min(1).max(100),
        supervisorIds: z.array(z.string().min(1)).max(20),
        environmentId: z.string().min(1).nullable().optional(),
        instructions: z.string().max(10_000).nullable().optional(),
        harness: z.enum(['hermes']).optional(),
        executable: z.string().min(1).max(60).nullable().optional(),
        providerId: z.string().min(1).nullable().optional(),
        modelId: z.string().min(1).nullable().optional(),
        apiKeySecretId: z.string().min(1).nullable().optional(),
      }))
      .handler(async ({ input }) => {
        const rows = await db.select().from(userTable).where(eq(userTable.id, input.id))
        const emp = rows[0]
        if (!emp) {
          throw new ORPCError('NOT_FOUND', { message: 'employee not found' })
        }
        const aiRow = (await db.select().from(aiEmployeesTable).where(eq(aiEmployeesTable.userId, input.id)))[0]
        if (new Set(input.supervisorIds).size !== input.supervisorIds.length) {
          throw new ORPCError('BAD_REQUEST', { message: 'duplicate supervisor ids' })
        }
        if (input.supervisorIds.includes(input.id)) {
          throw new ORPCError('BAD_REQUEST', { message: 'an employee cannot supervise themselves' })
        }
        // supervisors must exist; cycle check over the supervision graph
        const all = await db.select({ id: userTable.id }).from(userTable)
        const ids = new Set(all.map(a => a.id))
        for (const s of input.supervisorIds) {
          if (!ids.has(s)) {
            throw new ORPCError('BAD_REQUEST', { message: `supervisor ${s} does not exist` })
          }
        }
        const supRows = await db.select().from(supervisorsTable)
        const graph = new Map<string, string[]>()
        for (const r of supRows) {
          if (r.employeeId === input.id) continue // pretend the update applied
          ;(graph.get(r.employeeId) ?? graph.set(r.employeeId, []).get(r.employeeId)!).push(r.supervisorId)
        }
        graph.set(input.id, [...input.supervisorIds])
        // DFS from each supervisor upward: if we reach input.id -> cycle
        const seen = new Set<string>()
        const stack = [...input.supervisorIds]
        while (stack.length > 0) {
          const cur = stack.pop()!
          if (cur === input.id) {
            throw new ORPCError('BAD_REQUEST', { message: 'supervision cycle detected' })
          }
          if (seen.has(cur)) continue
          seen.add(cur)
          stack.push(...(graph.get(cur) ?? []))
        }
        // AI fields — only when this employee IS an AI (extension row exists)
        if (aiRow && (input.environmentId !== undefined || input.instructions !== undefined || input.harness !== undefined || input.executable !== undefined || input.providerId !== undefined || input.modelId !== undefined || input.apiKeySecretId !== undefined)) {
          const patch: { environmentId?: string, instructions?: string, harness?: string, executable?: string, providerId?: string | null, modelId?: string | null, apiKeySecretId?: string | null, updatedAt: Date } = { updatedAt: new Date() }
          if (input.environmentId !== undefined && input.environmentId !== null) {
            const env = await db.select({ id: environmentsTable.id }).from(environmentsTable).where(eq(environmentsTable.id, input.environmentId))
            if (env.length === 0) {
              throw new ORPCError('BAD_REQUEST', { message: 'environment does not exist' })
            }
            patch.environmentId = input.environmentId
          }
          if (input.instructions !== undefined && input.instructions !== null) {
            patch.instructions = input.instructions
          }
          if (input.harness !== undefined) {
            patch.harness = input.harness
          }
          if (input.executable !== undefined && input.executable !== null) {
            patch.executable = input.executable.trim() || 'hermes'
          }
          if (input.providerId !== undefined) {
            if (input.providerId !== null) {
              const provs = await db.select({ id: modelProvidersTable.id }).from(modelProvidersTable).where(eq(modelProvidersTable.id, input.providerId))
              if (provs.length === 0) {
                throw new ORPCError('BAD_REQUEST', { message: 'provider does not exist' })
              }
            }
            patch.providerId = input.providerId
          }
          if (input.modelId !== undefined) {
            if (input.modelId !== null) {
              const m = await db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.id, input.modelId))
              if (m.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'model does not exist' })
            }
            patch.modelId = input.modelId
          }
          if (input.apiKeySecretId !== undefined) {
            if (input.apiKeySecretId !== null) {
              const s = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.apiKeySecretId))
              if (s.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'api key secret not found' })
            }
            patch.apiKeySecretId = input.apiKeySecretId
          }
          await db.update(aiEmployeesTable).set(patch).where(eq(aiEmployeesTable.userId, aiRow.userId))
        }
        if (input.email !== undefined && input.email !== emp.email) {
          const clash = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, input.email))
          if (clash.length > 0) {
            throw new ORPCError('CONFLICT', { message: `user ${input.email} already exists` })
          }
        }
        await db.update(userTable).set({ name: input.name, title: input.title, ...(input.email !== undefined ? { email: input.email } : {}), updatedAt: new Date() }).where(eq(userTable.id, input.id))
        await db.delete(supervisorsTable).where(eq(supervisorsTable.employeeId, input.id))
        if (input.supervisorIds.length > 0) {
          await db.insert(supervisorsTable).values(input.supervisorIds.map(s => ({ employeeId: input.id, supervisorId: s })))
        }
        await publishChange('employees', 'update')
        return { ok: true }
      }),

    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        // guard: cannot delete yourself (session may be absent in raw handler tests)
        const selfId = (context as { session?: { user?: { id?: string } } }).session?.user?.id
        if (selfId && selfId === input.id) {
          throw new ORPCError('BAD_REQUEST', { message: 'you cannot delete your own account' })
        }
        // guard: cannot delete the last admin (workspace lockout)
        const target = (await db.select({ id: userTable.id, role: userTable.role }).from(userTable).where(eq(userTable.id, input.id)))[0]
        if (!target) {
          throw new ORPCError('NOT_FOUND', { message: 'employee not found' })
        }
        if (target.role === 'admin') {
          const admins = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.role, 'admin'))
          if (admins.length <= 1) {
            throw new ORPCError('BAD_REQUEST', { message: 'cannot delete the last admin' })
          }
        }
        // deleting the user cascades supervisors, ai extension, api keys
        // (existence already verified above — no race window worth a second check)
        await db.delete(userTable).where(eq(userTable.id, input.id))
        await publishChange('employees', 'delete')
        return { ok: true }
      }),

    /** mint a fresh API key for an AI employee (old keys stay valid) */
    createApiKey: protectedProcedure
      .input(z.strictObject({ employeeId: z.string().min(1) }))
      .handler(async ({ input }) => {
        const rows = await db.select().from(userTable).where(eq(userTable.id, input.employeeId))
        const emp = rows[0]
        if (!emp) throw new ORPCError('NOT_FOUND', { message: 'employee not found' })
        const aiRow = (await db.select().from(aiEmployeesTable).where(eq(aiEmployeesTable.userId, input.employeeId)))[0]
        if (!aiRow) throw new ORPCError('BAD_REQUEST', { message: 'API keys are for AI employees' })
        const { getAuth } = await import('./auth')
        const auth = await getAuth()
        const created = await auth.api.createApiKey({ body: { name: `employee ${emp.id.slice(0, 8)}`, userId: emp.id, prefix: 'tandem_' } })
        return { key: created.key, id: created.id }
      }),

    /** list an employee's API keys (never the key value) */
    listApiKeys: protectedProcedure
      .input(z.strictObject({ employeeId: z.string().min(1) }))
      .handler(async ({ input }): Promise<ApiKeyRow[]> => {
        const rows = await db.select().from(userTable).where(eq(userTable.id, input.employeeId))
        const emp = rows[0]
        if (!emp) throw new ORPCError('NOT_FOUND', { message: 'employee not found' })
        const keys = await db.select().from(apikeyTable).where(eq(apikeyTable.referenceId, emp.id)).orderBy(desc(apikeyTable.createdAt))
        return keys.map(k => ({
          id: k.id,
          name: k.name,
          start: k.start,
          prefix: k.prefix,
          expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
          createdAt: k.createdAt.toISOString(),
        }))
      }),

    /** revoke one API key */
    revokeApiKey: protectedProcedure
      .input(z.strictObject({ keyId: z.string().min(1) }))
      .handler(async ({ input }) => {
        const deleted = await db.delete(apikeyTable).where(eq(apikeyTable.id, input.keyId)).returning({ id: apikeyTable.id })
        if (deleted.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'api key not found' })
        }
        return { ok: true }
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
        if (input.secretId) {
          const secret = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.secretId))
          if (secret.length === 0) {
            throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' })
          }
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
        if (data.secretId) {
          const secret = await db.select({ id: vaultSecretsTable.id }).from(vaultSecretsTable).where(eq(vaultSecretsTable.id, data.secretId))
          if (secret.length === 0) {
            throw new ORPCError('NOT_FOUND', { message: 'linked secret not found' })
          }
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
      .handler(async ({ input, context }) => {
        const rows = await db.select().from(environmentsTable).where(eq(environmentsTable.id, input.id))
        const env = rows[0]
        if (!env) {
          throw new ORPCError('NOT_FOUND', { message: 'environment not found' })
        }
        // Linked vault secret: decrypt server-side (never exposed) and audit the use.
        let privateKey: string | undefined
        let usage: 'ssh-key' | 'password' = 'ssh-key'
        if (env.secretId) {
          const secretRows = await db.select().from(vaultSecretsTable).where(eq(vaultSecretsTable.id, env.secretId))
          const secret = secretRows[0]
          if (secret) {
            privateKey = decryptSecret(secret.ciphertext)
            usage = env.secretUsage === 'password' ? 'password' : 'ssh-key'
            await db.insert(vaultAuditTable).values({
              id: crypto.randomUUID(),
              secretId: secret.id,
              secretName: secret.name,
              action: 'use',
              actorId: context.session.user.id,
            })
          }
        }
        const started = Date.now()
        const result = await probeSsh(env.host, env.port, env.username, privateKey, usage)
        return { ...result, durationMs: Date.now() - started }
      }),
  },

  vault: {
    /** live list — metadata only; ciphertext never leaves the server */
    live: protectedProcedure.handler(() => liveGenerator(['vault'], listVaultSecrets)),

    /** audit trail, newest first */
    audit: protectedProcedure.handler(async () => {
      const rows = await db.select().from(vaultAuditTable).orderBy(desc(vaultAuditTable.at)).limit(200)
      return rows.map((r): VaultAuditRow => ({
        id: r.id,
        secretId: r.secretId,
        secretName: r.secretName,
        action: r.action as VaultAuditRow['action'],
        actorId: r.actorId,
        at: r.at.toISOString(),
      }))
    }),

    create: protectedProcedure
      .input(z.strictObject({
        name: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        value: z.string().min(1).max(64_000),
      }))
      .handler(async ({ input, context }) => {
        const inserted = await db.insert(vaultSecretsTable).values({
          id: crypto.randomUUID(),
          name: input.name,
          description: input.description,
          ciphertext: encryptSecret(input.value),
          lastFour: lastFourHint(input.value),
          createdBy: context.session.user.id,
        }).returning()
        await db.insert(vaultAuditTable).values({
          id: crypto.randomUUID(),
          secretId: inserted[0]!.id,
          secretName: input.name,
          action: 'create',
          actorId: context.session.user.id,
        })
        await publishChange('vault', 'create')
        return toVaultRow(inserted[0]!)
      }),

    /** value can be replaced but NEVER read back through the API */
    update: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1).max(100),
        description: z.string().max(500).default(''),
        value: z.string().min(1).max(64_000),
      }))
      .handler(async ({ input, context }) => {
        const { id, value, ...meta } = input
        const updated = await db.update(vaultSecretsTable)
          .set({ ...meta, ciphertext: encryptSecret(value), lastFour: lastFourHint(value), updatedAt: new Date() })
          .where(eq(vaultSecretsTable.id, id)).returning()
        if (updated.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
        }
        await db.insert(vaultAuditTable).values({
          id: crypto.randomUUID(),
          secretId: id,
          secretName: meta.name,
          action: 'update',
          actorId: context.session.user.id,
        })
        await publishChange('vault', 'update')
        return toVaultRow(updated[0]!)
      }),

    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        const deleted = await db.delete(vaultSecretsTable).where(eq(vaultSecretsTable.id, input.id)).returning({ id: vaultSecretsTable.id, name: vaultSecretsTable.name })
        if (deleted.length === 0) {
          throw new ORPCError('NOT_FOUND', { message: 'secret not found' })
        }
        await db.insert(vaultAuditTable).values({
          id: crypto.randomUUID(),
          secretId: null,
          secretName: deleted[0]!.name,
          action: 'delete',
          actorId: context.session.user.id,
        })
        await publishChange('vault', 'delete')
        return { ok: true }
      }),
  },
})

interface AuthSessionPayload {
  user: { id: string, name: string, email: string, role: 'admin' | 'employee' | 'viewer' }
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
      const rawRole = session.user.role ?? 'viewer'
      // DB column is text; the additionalField union guards writes, this
      // guard keeps reads honest
      const role: 'admin' | 'employee' | 'viewer'
        = rawRole === 'admin' || rawRole === 'employee' ? rawRole : 'viewer'
      cached = {
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role,
        },
      }
      return cached
    },
  }
}

export type ChangeBusEvent = ChangeEvent
