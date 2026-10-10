// M3: employees CRUD + supervision graph + API keys (oRPC procedures).
// Same harness pattern as orpc.test.ts: api-harness first (binds the mock
// auth singleton), helpers/pg before any server import (DATABASE_URL points
// at this file's throwaway DB at module-eval time), all other server imports
// lazy so nothing binds before the helper ran. The REAL api-key plugin runs
// against the throwaway DB (createApiKey writes a hashed row).
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../server/db/index'

const admin = { id: 'u1', name: 'A', email: 'a@x', role: 'admin' }

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null = admin) {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  return context
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { router } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

async function dbm() {
  return await import('../server/db')
}

async function schema() {
  return await import('../server/db/schema')
}

async function seedEnv(id: string): Promise<string> {
  const { db } = await dbm()
  const { environments } = await schema()
  await db.insert(environments).values({ id, name: id, host: '127.0.0.1', port: '22', username: 'u' })
  return id
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('employees.live', () => {
  it('returns an empty snapshot for a fresh database', async () => {
    const iter = await callProc('employees.live')
    const snap = await iter.next()
    expect(snap.value).toEqual([])
    await iter.return?.()
  })

  it('maps supervisors and AI extensions into rows', async () => {
    await seedEnv('env-live')
    const bot = await callProc('employees.create', { name: 'Bot One', email: 'bot1@tandem.local', kind: 'ai', title: 'Runner', environmentId: 'env-live' })
    const boss = await callProc('employees.create', { name: 'Human One', email: 'h1@tandem.local', kind: 'human', title: 'Boss', supervisorIds: [] })
    const { employeeSupervisors } = await schema()
    const { db } = await dbm()
    await db.insert(employeeSupervisors).values({ employeeId: bot.id, supervisorId: boss.id })
    const { publishChange } = await import('../server/utils/change-bus')
    publishChange('employees', 'update')

    const iter = await callProc('employees.live')
    const snap = await iter.next()
    const rows = snap.value as any[]
    const botRow = rows.find(r => r.kind === 'ai')!
    expect(botRow.name).toBe('Bot One')
    expect(botRow.supervisorIds).toEqual([boss.id])
    expect(botRow.environmentId).toBe('env-live')
    expect(botRow.instructions).toBe('')
    await iter.return?.()
  })
})

describe('employees.create', () => {
  it('creates a human employee + login user, no key', async () => {
    const out = await callProc('employees.create', { name: 'H', email: 'h@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    expect(out.apiKey).toBeUndefined()
    const { user } = await schema()
    const { db } = await dbm()
    const users = await db.select().from(user)
    expect(users).toHaveLength(1)
    // human = NO extension row
    const { aiEmployees } = await schema()
    expect(await db.select().from(aiEmployees)).toHaveLength(0)
    expect(users[0]!.role).toBe('employee')
    expect(users[0]!.email).toBe('h@tandem.local')
  })

  it('creates an AI employee with key + extension row + apikey row', async () => {
    await seedEnv('env-ai')
    const out = await callProc('employees.create', { name: 'AI', email: 'ai@tandem.local', kind: 'ai', title: 'Agent', environmentId: 'env-ai', instructions: 'be nice' })
    expect(out.apiKey).toMatch(/^tandem_/)
    const { aiEmployees, apikey } = await schema()
    const { db } = await dbm()
    const ai = await db.select().from(aiEmployees)
    expect(ai[0]!.instructions).toBe('be nice')
    expect(ai[0]!.environmentId).toBe('env-ai')
    const keys = await db.select().from(apikey)
    expect(keys).toHaveLength(1)
    expect(keys[0]!.key).not.toBe(out.apiKey) // stored hashed, never plaintext
  })

  it('rejects AI without environment', async () => {
    await expect(callProc('employees.create', { name: 'AI', email: 'ai2@tandem.local', kind: 'ai', title: 'Agent' }))
      .rejects.toThrow(/environment/i)
  })

  it('rejects human with AI fields', async () => {
    await seedEnv('env-hum')
    await expect(callProc('employees.create', { name: 'H', email: 'h-ai@tandem.local', kind: 'human', title: 'T', supervisorIds: [], environmentId: 'env-hum' }))
      .rejects.toThrow(/AI employees only/i)
  })

  it('rejects unknown supervisor', async () => {
    await expect(callProc('employees.create', { name: 'H', email: 'h3@tandem.local', kind: 'human', title: 'T', supervisorIds: ['ghost'] }))
      .rejects.toThrow(/does not exist/i)
  })

  it('rejects duplicate supervisors', async () => {
    const b = await callProc('employees.create', { name: 'B', email: 'b@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await expect(callProc('employees.create', { name: 'H', email: 'h4@tandem.local', kind: 'human', title: 'T', supervisorIds: [b.id, b.id] }))
      .rejects.toThrow(/duplicate/i)
  })

  it('rejects taken email', async () => {
    await callProc('employees.create', { name: 'A', email: 'dup@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await expect(callProc('employees.create', { name: 'B', email: 'dup@tandem.local', kind: 'human', title: 'T', supervisorIds: [] }))
      .rejects.toThrow(/already exists/i)
  })

  it('rejects unknown environment', async () => {
    await expect(callProc('employees.create', { name: 'AI', email: 'ai3@tandem.local', kind: 'ai', title: 'A', environmentId: 'ghost-env' }))
      .rejects.toThrow(/environment does not exist/i)
  })
})

describe('employees.update', () => {
  it('updates title/name, replaces supervisors, no cycle', async () => {
    const a = await callProc('employees.create', { name: 'A', email: 'a@tandem.local', kind: 'human', title: 'T1', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'b@tandem.local', kind: 'human', title: 'T2', supervisorIds: [] })
    await callProc('employees.update', { id: b.id, name: 'B2', title: 'T2b', supervisorIds: [a.id] })
    const { employeeSupervisors, user } = await schema()
    const { db } = await dbm()
    const sups = await db.select().from(employeeSupervisors)
    expect(sups.map(s => s.supervisorId)).toEqual([a.id])
    const users = await db.select().from(user)
    expect(users.find(u => u.id === b.userId)!.name).toBe('B2')
  })

  it('rejects self-supervision', async () => {
    const a = await callProc('employees.create', { name: 'A', email: 's@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await expect(callProc('employees.update', { id: a.id, name: 'A', title: 'T', supervisorIds: [a.id] }))
      .rejects.toThrow(/themselves/i)
  })

  it('rejects a supervision cycle', async () => {
    const a = await callProc('employees.create', { name: 'A', email: 'c1@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'c2@tandem.local', kind: 'human', title: 'T', supervisorIds: [a.id] })
    // b -> a exists; making a supervised by b closes the loop
    await expect(callProc('employees.update', { id: a.id, name: 'A', title: 'T', supervisorIds: [b.id] }))
      .rejects.toThrow(/cycle/i)
  })

  it('handles diamond graphs without false cycles', async () => {
    // a tops b and c; b and c both top d; updating d with [b, c] is fine
    const a = await callProc('employees.create', { name: 'A', email: 'dm1@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'dm2@tandem.local', kind: 'human', title: 'T', supervisorIds: [a.id] })
    const c = await callProc('employees.create', { name: 'C', email: 'dm3@tandem.local', kind: 'human', title: 'T', supervisorIds: [a.id] })
    const d = await callProc('employees.create', { name: 'D', email: 'dm4@tandem.local', kind: 'human', title: 'T', supervisorIds: [b.id, c.id] })
    expect(d.id).toBeTruthy()
    // and b -> a exists while updating b with [a] stays legal (no cycle)
    await callProc('employees.update', { id: b.id, name: 'B', title: 'T', supervisorIds: [a.id] })
  })

  it('rejects deep cycles and walks converging paths (seen-guard)', async () => {
    // a tops b; b tops c and d; c and d both top e (converging diamond).
    const a = await callProc('employees.create', { name: 'A', email: 'x1@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'x2@tandem.local', kind: 'human', title: 'T', supervisorIds: [a.id] })
    const c = await callProc('employees.create', { name: 'C', email: 'x3@tandem.local', kind: 'human', title: 'T', supervisorIds: [b.id] })
    const d = await callProc('employees.create', { name: 'D', email: 'x4@tandem.local', kind: 'human', title: 'T', supervisorIds: [b.id] })
    const e = await callProc('employees.create', { name: 'E', email: 'x5@tandem.local', kind: 'human', title: 'T', supervisorIds: [c.id, d.id] })
    // no cycle: e supervised by [c, d] — the walk revisits b via both arms
    // and the seen-guard prunes the second visit (this passes)
    await callProc('employees.update', { id: e.id, name: 'E', title: 'T', supervisorIds: [c.id, d.id] })
    // cycle: a supervised by e -> e,(c|d),b -> a — thrown on reaching a
    await expect(callProc('employees.update', { id: a.id, name: 'A', title: 'T', supervisorIds: [e.id] }))
      .rejects.toThrow(/cycle/i)
  })

  it('rejects unknown employee id', async () => {
    await expect(callProc('employees.update', { id: 'ghost', name: 'G', title: 'T', supervisorIds: [] }))
      .rejects.toThrow(/not found/i)
  })

  it('rejects duplicate supervisor ids', async () => {
    const a = await callProc('employees.create', { name: 'A', email: 'd1@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'd2@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await expect(callProc('employees.update', { id: b.id, name: 'B', title: 'T', supervisorIds: [a.id, a.id] }))
      .rejects.toThrow(/duplicate/i)
  })

  it('rejects unknown supervisor on update', async () => {
    const a = await callProc('employees.create', { name: 'A', email: 'us@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await expect(callProc('employees.update', { id: a.id, name: 'A', title: 'T', supervisorIds: ['ghost'] }))
      .rejects.toThrow(/does not exist/i)
  })

  it('updates AI environment and instructions', async () => {
    await seedEnv('env-one')
    await seedEnv('env-two')
    const a = await callProc('employees.create', { name: 'AI', email: 'ai-u@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-one', instructions: 'x' })
    await callProc('employees.update', { id: a.id, name: 'AI', title: 'A2', supervisorIds: [], environmentId: 'env-two', instructions: 'y' })
    const { aiEmployees } = await schema()
    const { db } = await dbm()
    const ai = await db.select().from(aiEmployees)
    expect(ai[0]!.environmentId).toBe('env-two')
    expect(ai[0]!.instructions).toBe('y')
  })

  it('rejects unknown environment on AI update', async () => {
    await seedEnv('env-ue')
    const a = await callProc('employees.create', { name: 'AI', email: 'ue-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-ue' })
    await expect(callProc('employees.update', { id: a.id, name: 'AI', title: 'A', supervisorIds: [], environmentId: 'ghost-env', instructions: 'y' }))
      .rejects.toThrow(/environment does not exist/i)
  })

  it('updates instructions only (environment untouched)', async () => {
    await seedEnv('env-io')
    const a = await callProc('employees.create', { name: 'AI', email: 'io-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-io', instructions: 'x' })
    await callProc('employees.update', { id: a.id, name: 'AI', title: 'A', supervisorIds: [], instructions: 'z' })
    const { aiEmployees } = await schema()
    const { db } = await dbm()
    const ai = await db.select().from(aiEmployees)
    expect(ai[0]!.environmentId).toBe('env-io')
    expect(ai[0]!.instructions).toBe('z')
  })

  it('treats explicit null instructions/environment as no-change', async () => {
    await seedEnv('env-null')
    const a = await callProc('employees.create', { name: 'AI', email: 'n-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-null', instructions: 'keep' })
    await callProc('employees.update', { id: a.id, name: 'AI', title: 'A', supervisorIds: [], environmentId: null, instructions: null })
    const { aiEmployees } = await schema()
    const { db } = await dbm()
    const ai = await db.select().from(aiEmployees)
    expect(ai[0]!.instructions).toBe('keep')
    expect(ai[0]!.environmentId).toBe('env-null')
  })

  it('ignores AI fields for humans', async () => {
    const a = await callProc('employees.create', { name: 'H', email: 'ig@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await callProc('employees.update', { id: a.id, name: 'H', title: 'T', supervisorIds: [], environmentId: null, instructions: null })
    const { aiEmployees } = await schema()
    const { db } = await dbm()
    expect(await db.select().from(aiEmployees)).toHaveLength(0)
  })
})

describe('employees.remove', () => {
  it('deletes employee, cascades supervisors + ai row + login user', async () => {
    await seedEnv('env-del')
    const a = await callProc('employees.create', { name: 'A', email: 'del-a@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const b = await callProc('employees.create', { name: 'B', email: 'del-b@tandem.local', kind: 'ai', title: 'T', environmentId: 'env-del', supervisorIds: [a.id] })
    await callProc('employees.remove', { id: a.id })
    const { employeeSupervisors, aiEmployees, user } = await schema()
    const { db } = await dbm()
    expect(await db.select().from(employeeSupervisors)).toHaveLength(0)
    expect(await db.select().from(user)).toHaveLength(1) // b's login survives; a's gone
    await callProc('employees.remove', { id: b.id })
    expect(await db.select().from(aiEmployees)).toHaveLength(0)
    expect(await db.select().from(user)).toHaveLength(0)
  })

  it('refuses self-deletion', async () => {
    const { router } = await import('../server/utils/orpc')
    const { db } = await dbm()
    const { user } = await schema()
    await db.insert(user).values({ id: 'u1', name: 'Sess', email: 'sess@tandem.local', role: 'viewer' })
    // call the handler with a session present (as requireSession middleware provides)
    const node = (router as any).employees.remove['~orpc']
    await expect(node.handler({
      input: { id: 'u1' },
      context: { ...(await ctx()), session: { user: { id: 'u1', name: 'Sess', email: 'sess@tandem.local', role: 'viewer' } } },
      signal: new AbortController().signal,
    })).rejects.toThrow(/own account/i)
    expect(await db.select().from(user)).toHaveLength(1) // nothing deleted
  })

  it('refuses deleting the last admin', async () => {
    // seed a second employee (non-admin); the ONLY admin is the session admin's row.
    // Create an admin user directly, delete the OTHER admin? Simpler: make the target an admin with no other admins.
    const { db } = await dbm()
    const { user } = await schema()
    // promote Self to admin, then delete the original admin while Self is... admin too (2 admins = allowed).
    // For the guard: single-admin case. Remove the second user; target = the only admin.
    await db.insert(user).values({ id: 'only-admin', name: 'OA', email: 'oa@tandem.local', role: 'admin' })
    await expect(callProc('employees.remove', { id: 'only-admin' })).rejects.toThrow(/last admin/i)
    // now add another admin -> deletion allowed
    await db.insert(user).values({ id: 'admin-2', name: 'A2', email: 'a2@tandem.local', role: 'admin' })
    await expect(callProc('employees.remove', { id: 'only-admin' })).resolves.toMatchObject({ ok: true })
  })

  it('404s on unknown id', async () => {
    await expect(callProc('employees.remove', { id: 'ghost' })).rejects.toThrow(/not found/i)
  })
})

describe('employees API keys', () => {
  it('createApiKey mints for AI employees only', async () => {
    await seedEnv('env-key')
    const ai = await callProc('employees.create', { name: 'AI', email: 'k-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-key' })
    const h = await callProc('employees.create', { name: 'H', email: 'k-h@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const minted = await callProc('employees.createApiKey', { employeeId: ai.id })
    expect(minted.key).toMatch(/^tandem_/)
    await expect(callProc('employees.createApiKey', { employeeId: h.id })).rejects.toThrow(/AI employees/i)
  })

  it('createApiKey 404s unknown employee', async () => {
    await expect(callProc('employees.createApiKey', { employeeId: 'ghost' })).rejects.toThrow(/not found/i)
  })

  it('listApiKeys returns metadata only (no key value)', async () => {
    await seedEnv('env-lst')
    const ai = await callProc('employees.create', { name: 'AI', email: 'l-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-lst' })
    const minted = await callProc('employees.createApiKey', { employeeId: ai.id })
    const keys = await callProc('employees.listApiKeys', { employeeId: ai.id })
    expect(keys).toHaveLength(2) // creation key + minted
    for (const k of keys) {
      expect(k.key).toBeUndefined()
      expect(k.prefix).toBe('tandem_')
    }
    expect(keys.some((k: any) => k.id === minted.id)).toBe(true)
  })

  it('listApiKeys 404s unknown employee', async () => {
    await expect(callProc('employees.listApiKeys', { employeeId: 'ghost' })).rejects.toThrow(/not found/i)
  })

  it('revokeApiKey deletes the key', async () => {
    await seedEnv('env-rev')
    const ai = await callProc('employees.create', { name: 'AI', email: 'r-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-rev' })
    const minted = await callProc('employees.createApiKey', { employeeId: ai.id })
    await callProc('employees.revokeApiKey', { keyId: minted.id })
    const keys = await callProc('employees.listApiKeys', { employeeId: ai.id })
    expect(keys).toHaveLength(1) // only the creation key remains
  })

  it('listApiKeys maps expiresAt both ways', async () => {
    await seedEnv('env-exp')
    const ai = await callProc('employees.create', { name: 'AI', email: 'exp-ai@tandem.local', kind: 'ai', title: 'A', environmentId: 'env-exp' })
    // creation key has no expiry
    const before = await callProc('employees.listApiKeys', { employeeId: ai.id })
    expect(before[0].expiresAt).toBeNull()
    // seed one WITH expiry via the real plugin (verifyApiKey path not needed)
    const { getAuth } = await import('../server/utils/auth')
    const auth = await getAuth()
    const { db } = await dbm()
    const { apikey } = await schema()
    await db.update(apikey).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq((await schema()).apikey.id, before[0].id))
    const after = await callProc('employees.listApiKeys', { employeeId: ai.id })
    expect(after[0].expiresAt).not.toBeNull()
  })

  it('revokeApiKey 404s unknown key', async () => {
    await expect(callProc('employees.revokeApiKey', { keyId: 'ghost' })).rejects.toThrow(/not found/i)
  })
})

describe('AI harness + executable', () => {
  it('defaults harness hermes / executable hermes when omitted', async () => {
    await seedEnv('env-h1')
    const r = await callProc('employees.create', { name: 'Default Harness', email: 'dh@tandem.local', kind: 'ai', title: 'T', environmentId: 'env-h1' })
    const iter = await callProc('employees.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(x => x.id === r.id)!
    expect(row.harness).toBe('hermes')
    expect(row.executable).toBe('hermes')
  })

  it('persists custom executable (trimmed) via create and update', async () => {
    await seedEnv('env-h2')
    const r = await callProc('employees.create', { name: 'Custom Exe', email: 'ce@tandem.local', kind: 'ai', title: 'T', environmentId: 'env-h2', executable: '  hermes-dev  ' })
    const { aiEmployees, user } = await schema()
    const { db } = await dbm()
    let ai = (await db.select().from(aiEmployees).where(eq(aiEmployees.userId, r.id)))[0]!
    expect(ai.executable).toBe('hermes-dev')
    expect(ai.harness).toBe('hermes')
    await callProc('employees.update', { id: r.id, name: 'Custom Exe', title: 'T', supervisorIds: [], executable: 'hermes-nightly' })
    ai = (await db.select().from(aiEmployees).where(eq(aiEmployees.userId, r.id)))[0]!
    expect(ai.executable).toBe('hermes-nightly')
    // blank resets to default
    await callProc('employees.update', { id: r.id, name: 'Custom Exe', title: 'T', supervisorIds: [], executable: '' })
    ai = (await db.select().from(aiEmployees).where(eq(aiEmployees.userId, r.id)))[0]!
    expect(ai.executable).toBe('hermes')
  })

  it('update harness change persists', async () => {
    await seedEnv('env-h4')
    const r = await callProc('employees.create', { name: 'Upd Harness', email: 'uh@tandem.local', kind: 'ai', title: 'T', environmentId: 'env-h4' })
    await callProc('employees.update', { id: r.id, name: 'Upd Harness', title: 'T', supervisorIds: [], harness: 'hermes' })
    const iter = await callProc('employees.live')
    const snap = await iter.next()
    await iter.return?.()
    const row = (snap.value as any[]).find(x => x.id === r.id)!
    expect(row.harness).toBe('hermes')
  })

  it('update changes email; duplicate rejected with CONFLICT', async () => {
    await callProc('employees.create', { name: 'Email A', email: 'ea@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    await callProc('employees.create', { name: 'Email B', email: 'eb@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const { user } = await schema()
    const { db } = await dbm()
    const a = (await db.select().from(user).where(eq(user.email, 'ea@tandem.local')))[0]!
    await callProc('employees.update', { id: a.id, name: 'Email A', email: 'ea2@tandem.local', title: 'T', supervisorIds: [] })
    expect((await db.select().from(user).where(eq(user.id, a.id)))[0]!.email).toBe('ea2@tandem.local')
    // eb already owns it
    await expect(callProc('employees.update', { id: a.id, name: 'Email A', email: 'eb@tandem.local', title: 'T', supervisorIds: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('human create rejects harness/executable', async () => {
    await expect(callProc('employees.create', { name: 'No Harness', email: 'nh@tandem.local', kind: 'human', title: 'T', supervisorIds: [], harness: 'hermes', executable: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('live maps harness/executable for AI rows, null for humans', async () => {
    await seedEnv('env-h3')
    const r = await callProc('employees.create', { name: 'Map Bot', email: 'mb@tandem.local', kind: 'ai', title: 'T', environmentId: 'env-h3', executable: 'hdev' })
    await callProc('employees.create', { name: 'Map Human', email: 'mh@tandem.local', kind: 'human', title: 'T', supervisorIds: [] })
    const iter = await callProc('employees.live')
    const snap = await iter.next()
    await iter.return?.()
    const rows = snap.value as any[]
    const ai = rows.find(x => x.id === r.id)!
    const hu = rows.find(x => x.kind === 'human')!
    expect(ai.harness).toBe('hermes')
    expect(ai.executable).toBe('hdev')
    expect(hu.harness).toBeNull()
    expect(hu.executable).toBeNull()
  })
})
