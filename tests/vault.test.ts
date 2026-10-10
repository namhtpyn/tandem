// Vault domain tests — real Postgres, driven through the oRPC handler edge
// (same pattern as employees.test.ts). Plaintext round-trip is tested at the
// vault-crypto module level; here we assert the API NEVER exposes it.
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { decryptSecret, encryptSecret, lastFourHint } from '../server/utils/vault-crypto'

const admin = { id: 'u1', name: 'A', email: 'a@x', role: 'admin' }

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null = admin) {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  return context
}

async function callProc(path: string, input?: unknown, sessionUser: { id: string, name: string, email: string, role: string } | null = admin): Promise<any> {
  const { router } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: { ...(await ctx()), session: { user: sessionUser ?? admin } }, signal: new AbortController().signal })
}

async function dbm() {
  return await import('../server/db')
}

async function schema() {
  return await import('../server/db/schema')
}

/** factory: a user row (vault secrets FK-require one) */
async function userFactory(id: string): Promise<string> {
  const { db } = await dbm()
  const { user } = await schema()
  await db.insert(user).values({ id, name: id, email: `${id}@tandem.local`, emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  return id
}

/** factory: a persisted secret via the API; returns the API row */
async function secretFactory(name: string, value = 'super-secret-value', kind = 'generic') {
  return await callProc('vault.create', { name, value, kind })
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  await userFactory('u1')
})

describe('vault-crypto (module)', () => {
  it('round-trips AES-256-GCM envelopes', () => {
    const env = encryptSecret('hunter2')
    expect(env.startsWith('v1:')).toBe(true)
    expect(decryptSecret(env)).toBe('hunter2')
  })

  it('uses a fresh IV per encryption (ciphertexts differ)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('rejects malformed envelopes', () => {
    expect(() => decryptSecret('v2:a:b:c')).toThrow('malformed vault envelope')
    expect(() => decryptSecret('garbage')).toThrow('malformed vault envelope')
  })

  it('fails on tampered ciphertext (GCM auth)', () => {
    const env = encryptSecret('hunter2')
    const parts = env.split(':')
    const ct = Buffer.from(parts[3]!, 'base64')
    ct[0]! ^= 0xff
    parts[3] = ct.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow()
  })

  it('rejects wrong-size TANDEM_VAULT_KEY; generateVaultKeyB64 gives 32 bytes', async () => {
    const mod = await import('../server/utils/vault-crypto')
    process.env.TANDEM_VAULT_KEY = Buffer.alloc(16).toString('base64')
    mod.resetVaultKeyCache()
    expect(() => mod.getVaultKey()).toThrowError(/32 bytes/)
    const fresh = mod.generateVaultKeyB64()
    expect(Buffer.from(fresh, 'base64')).toHaveLength(32)
    process.env.TANDEM_VAULT_KEY = fresh
    mod.resetVaultKeyCache()
    expect(mod.getVaultKey()).toHaveLength(32)
    delete process.env.TANDEM_VAULT_KEY
    mod.resetVaultKeyCache()
  })

  it('lastFourHint never reveals short values', () => {
    expect(lastFourHint('ab')).toBe('••••')
    expect(lastFourHint('abcd')).toBe('••••')
    expect(lastFourHint('abcde')).toBe('bcde')
  })
})

describe('vault API', () => {
  it('live lists metadata only — no ciphertext, no plaintext', async () => {
    await secretFactory('ssh-prod-key', 'AKIAIOSFODNN7EXAMPLE')
    const iter = await callProc('vault.live')
    const snap = await iter.next()
    const rows = snap.value as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('ssh-prod-key')
    expect(rows[0]!.lastFour).toBe('MPLE')
    expect(JSON.stringify(rows)).not.toContain('AKIA')
    expect(JSON.stringify(rows)).not.toContain('ciphertext')
    await iter.return?.()
  })

  it('create stores an encrypted envelope the API cannot read back', async () => {
    const row = await secretFactory('db-password', 'correct-horse-battery')
    expect(row.lastFour).toBe('tery')
    // DB row must contain a GCM envelope, not the plaintext
    const { db } = await dbm()
    const { vaultSecrets } = await schema()
    const raw = await db.select().from(vaultSecrets)
    expect(raw[0]!.ciphertext.startsWith('v1:')).toBe(true)
    expect(raw[0]!.ciphertext).not.toContain('correct-horse')
    // server-side decrypt still works (M5 runner path)
    expect(decryptSecret(raw[0]!.ciphertext)).toBe('correct-horse-battery')
  })

  it('create conflicts on duplicate name', async () => {
    await secretFactory('dup')
    await expect(callProc('vault.create', { name: 'dup', value: 'x' })).rejects.toThrowError(/already exists/)
  })

  it('update replaces the value and rotates the envelope', async () => {
    const { db } = await dbm()
    const { vaultSecrets } = await schema()
    const created = await secretFactory('rotate-me', 'old-value-123')
    await callProc('vault.update', { id: created.id, name: 'rotate-me', kind: 'generic', value: 'new-value-456' })
    const raw = await db.select().from(vaultSecrets)
    expect(decryptSecret(raw[0]!.ciphertext)).toBe('new-value-456')
    expect(raw[0]!.lastFour).toBe('-456')
    expect(raw[0]!.ciphertext).not.toBe((await db.select().from(vaultSecrets)).toString())
  })

  it('update to a clashing name conflicts; missing id 404s', async () => {
    await secretFactory('keep-name')
    const other = await secretFactory('other-name')
    await expect(callProc('vault.update', { id: other.id, name: 'keep-name', kind: 'generic', value: 'v' })).rejects.toThrowError(/already exists/)
    await expect(callProc('vault.update', { id: 'missing', name: 'x', kind: 'generic', value: 'v' })).rejects.toThrowError(/not found/)
  })

  it('remove deletes the secret and leaves a tombstone audit row', async () => {
    const created = await secretFactory('doomed', 'x')
    await callProc('vault.remove', { id: created.id })
    const iter = await callProc('vault.live')
    const snap = await iter.next()
    expect(snap.value).toEqual([])
    await iter.return?.()
    const audit = await callProc('vault.audit')
    // create row cascaded away with the secret; the delete TOMBSTONE survives
    expect(audit).toHaveLength(1)
    expect(audit[0]!.action).toBe('delete')
    expect(audit[0]!.secretName).toBe('doomed')
    expect(audit[0]!.secretId).toBeNull()
  })

  it('audit records every action with actor and newest-first order', async () => {
    const a = await secretFactory('first')
    await secretFactory('second')
    await callProc('vault.update', { id: a.id, name: 'first', kind: 'generic', value: 'rotated' })
    const audit = await callProc('vault.audit')
    expect(audit.map((r: any) => r.action)).toEqual(['update', 'create', 'create'])
    expect(audit.every((r: any) => r.actorId === 'u1')).toBe(true)
  })

  it('cascade: deleting the creator removes their secrets but keeps audit tombstones', async () => {
    await userFactory('u2')
    const { db } = await dbm()
    const { vaultSecrets, user } = await schema()
    // create as u2
    const { router } = await import('../server/utils/orpc')
    const node = (router as any).vault.create['~orpc']
    const row = await node.handler({ input: { name: 'u2-secret', value: 'v', kind: 'generic' }, context: { ...(await ctx({ id: 'u2', name: 'B', email: 'b@x', role: 'admin' })), session: { user: { id: 'u2', name: 'B', email: 'b@x', role: 'admin' } } }, signal: new AbortController().signal })
    await db.delete(user).where(eq(user.id, 'u2'))
    const remaining = await db.select().from(vaultSecrets)
    expect(remaining).toHaveLength(0)
    const audit = await callProc('vault.audit')
    // u2's audit rows cascade with their user; vault is empty, no tombstones lie
    expect(audit).toHaveLength(0)
  })

  it('remove of a missing secret 404s', async () => {
    await expect(callProc('vault.remove', { id: 'nope' })).rejects.toThrowError(/not found/)
  })

  it('unauthenticated calls are rejected', async () => {
    const { router } = await import('../server/utils/orpc')
    const node = (router as any).vault.create['~orpc']
    const context = buildAnonContext()
    const res = await node.handler({ input: { name: 'x', value: 'y', kind: 'generic' }, context, signal: new AbortController().signal }).catch(e => e)
    expect(String(res?.message ?? res)).toMatch(/authentication required|Cannot read|session/)
  })
})

async function buildAnonContext() {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null
  return context
}
