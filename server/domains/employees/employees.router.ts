import { os } from '@orpc/server'
// employees router — business logic lives in services/utils; this file only wires procedures
import { asc, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { endpointKind, PROVIDER_KIND } from '#shared/api-styles'
import {
  aiEmployees as aiEmployeesTable, apikey as apikeyTable, employeeSupervisors as supervisorsTable, employeeTitles as employeeTitlesTable, environments as environmentsTable, modelProviders as modelProvidersTable, user as userTable, vaultSecrets as vaultSecretsTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import type { ApiKeyRow, EmployeeRow } from '../../../shared/types'

export const employeesRouter = os.router({
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
        model: ai?.model ?? null,
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
      model: z.string().min(1).max(200).nullable().optional(),
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
        await db.insert(aiEmployeesTable).values({
          userId,
          environmentId: input.environmentId!,
          instructions: input.instructions ?? '',
          harness: input.harness ?? 'hermes',
          executable: input.executable?.trim() || 'hermes',
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          apiKeySecretId: input.apiKeySecretId ?? null,
        })
      }
      // every new employee — AI or human — gets an initial access key (shown once)
      {
        const { getAuth } = await import('../auth/auth.service')
        const auth = await getAuth()
        const created = await auth.api.createApiKey({ body: { name: `${input.name.slice(0, 40)} access key`, userId, prefix: 'tandem_' } })
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
      model: z.string().min(1).max(200).nullable().optional(),
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
      if (aiRow && (input.environmentId !== undefined || input.instructions !== undefined || input.harness !== undefined || input.executable !== undefined || input.providerId !== undefined || input.model !== undefined || input.apiKeySecretId !== undefined)) {
        const patch: { environmentId?: string, instructions?: string, harness?: string, executable?: string, providerId?: string | null, model?: string | null, apiKeySecretId?: string | null, updatedAt: Date } = { updatedAt: new Date() }
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
        if (input.model !== undefined) patch.model = input.model
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

  titles: {
    live: protectedProcedure
      .handler(() => liveGenerator(['employees'], async () => {
        const rows = await db.select().from(employeeTitlesTable).orderBy(asc(employeeTitlesTable.name))
        const counts = await db.select({ title: userTable.title, count: count() }).from(userTable).groupBy(userTable.title)
        const byTitle = new Map(counts.map(c => [c.title, Number(c.count)]))
        return { titles: rows.map(t => ({ id: t.id, name: t.name, employees: byTitle.get(t.name) ?? 0 })) }
      })),

    save: protectedProcedure
      .input(z.strictObject({
        id: z.string().min(1).optional(),
        name: z.string().min(1).max(80),
      }))
      .handler(async ({ input }) => {
        if (input.id === undefined) {
          const dupe = await db.select({ id: employeeTitlesTable.id }).from(employeeTitlesTable).where(eq(employeeTitlesTable.name, input.name))
          if (dupe.length > 0) throw new ORPCError('BAD_REQUEST', { message: 'a title with that name already exists' })
          const inserted = await db.insert(employeeTitlesTable).values({ id: crypto.randomUUID(), name: input.name }).returning()
          await publishChange('employees', 'create')
          return { id: inserted[0]!.id }
        }
        const existing = (await db.select({ name: employeeTitlesTable.name }).from(employeeTitlesTable).where(eq(employeeTitlesTable.id, input.id)))[0]
        if (!existing) throw new ORPCError('NOT_FOUND', { message: 'title not found' })
        // rename cascades to employees holding the old title (free-text column, no FK)
        await db.update(userTable).set({ title: input.name, updatedAt: new Date() }).where(eq(userTable.title, existing.name))
        await db.update(employeeTitlesTable).set({ name: input.name, updatedAt: new Date() }).where(eq(employeeTitlesTable.id, input.id))
        await publishChange('employees', 'update')
        return { id: input.id }
      }),

    /** removing a catalog entry leaves employees' free-text titles untouched */
    remove: protectedProcedure
      .input(z.strictObject({ id: z.string().min(1) }))
      .handler(async ({ input }) => {
        const deleted = await db.delete(employeeTitlesTable).where(eq(employeeTitlesTable.id, input.id)).returning({ id: employeeTitlesTable.id })
        if (deleted.length === 0) throw new ORPCError('NOT_FOUND', { message: 'title not found' })
        await publishChange('employees', 'remove')
        return { ok: true }
      }),
  },

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

  /** mint a fresh access key for any employee — AI or human (old keys stay valid) */
  createApiKey: protectedProcedure
    .input(z.strictObject({
      employeeId: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
    }))
    .handler(async ({ input }) => {
      const rows = await db.select().from(userTable).where(eq(userTable.id, input.employeeId))
      const emp = rows[0]
      if (!emp) throw new ORPCError('NOT_FOUND', { message: 'employee not found' })
      const { getAuth } = await import('../auth/auth.service')
      const auth = await getAuth()
      const created = await auth.api.createApiKey({ body: { name: input.name?.trim() || `${emp.name.slice(0, 40)} key`, userId: emp.id, prefix: 'tandem_' } })
      return { key: created.key, id: created.id }
    }),

  /** rename an access key */
  updateApiKey: protectedProcedure
    .input(z.strictObject({
      keyId: z.string().min(1),
      name: z.string().min(1).max(100),
    }))
    .handler(async ({ input }) => {
      const name = input.name.trim()
      if (!name) throw new ORPCError('BAD_REQUEST', { message: 'name is required' })
      const updated = await db.update(apikeyTable).set({ name }).where(eq(apikeyTable.id, input.keyId)).returning({ id: apikeyTable.id })
      if (updated.length === 0) throw new ORPCError('NOT_FOUND', { message: 'api key not found' })
      return { ok: true }
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
})
