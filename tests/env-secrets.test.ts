// Environment <-> vault secret linkage tests (real Postgres, oRPC edge).
// SSH key auth itself is exercised in ssh-probe tests + e2e; here we verify
// the linkage lifecycle: FK validation, set-null on secret delete, probe
// decrypt + audit-use behavior.
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
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
  return await internals.handler({ input, context: { ...(await ctx()), session: { user: admin } }, signal: new AbortController().signal })
}

async function dbm() {
  return await import('../server/db')
}

async function schema() {
  return await import('../server/db/schema')
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await dbm()
  const { user } = await schema()
  await db.insert(user).values({ id: 'u1', name: 'A', email: 'a@x', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
})

describe('environment secret linkage', () => {
  it('create accepts secretId and returns it in rows', async () => {
    const secret = await callProc('vault.create', { name: 'env-key', value: 'PRIVATE KEY MATERIAL', kind: 'ssh-key' })
    const env = await callProc('environments.create', { name: 'box', host: '127.0.0.1', port: '22', username: 'u', secretId: secret.id })
    expect(env.secretId).toBe(secret.id)
    const iter = await callProc('environments.live')
    const snap = await iter.next()
    expect(snap.value[0]!.secretId).toBe(secret.id)
    await iter.return?.()
  })

  it('secretId defaults to null when omitted', async () => {
    const env = await callProc('environments.create', { name: 'nosecret', host: '127.0.0.1', port: '22', username: 'u' })
    expect(env.secretId).toBeNull()
  })

  it('create with unknown secretId 404s', async () => {
    await expect(callProc('environments.create', { name: 'bad', host: 'h', port: '22', username: 'u', secretId: 'missing' }))
      .rejects.toThrowError(/linked secret not found/)
  })

  it('update with unknown secretId 404s; update can link/unlink', async () => {
    const env = await callProc('environments.create', { name: 'box', host: 'h', port: '22', username: 'u' })
    await expect(callProc('environments.update', { id: env.id, name: 'box', host: 'h', port: '22', username: 'u', secretId: 'missing' }))
      .rejects.toThrowError(/linked secret not found/)
    const secret = await callProc('vault.create', { name: 'k1', value: 'v1', kind: 'ssh-key' })
    const linked = await callProc('environments.update', { id: env.id, name: 'box', host: 'h', port: '22', username: 'u', secretId: secret.id })
    expect(linked.secretId).toBe(secret.id)
    const unlinked = await callProc('environments.update', { id: env.id, name: 'box', host: 'h', port: '22', username: 'u', secretId: null })
    expect(unlinked.secretId).toBeNull()
  })

  it('deleting the secret set-nulls the environment link (no dangling FK)', async () => {
    const secret = await callProc('vault.create', { name: 'doomed-key', value: 'v', kind: 'ssh-key' })
    const env = await callProc('environments.create', { name: 'box', host: 'h', port: '22', username: 'u', secretId: secret.id })
    await callProc('vault.remove', { id: secret.id })
    const { db } = await dbm()
    const { environments } = await schema()
    const rows = await db.select().from(environments)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.secretId).toBeNull()
  })

  it('probe with a linked secret decrypts server-side and audits the use', async () => {
    const secret = await callProc('vault.create', { name: 'probe-key', value: 'not-a-real-key', kind: 'ssh-key' })
    const env = await callProc('environments.create', { name: 'probe-box', host: '127.0.0.1', port: '59999', username: 'u', secretId: secret.id })
    // port 59999: nothing listens -> probe fails fast, but the KEY was
    // decrypted + audited BEFORE the ssh attempt
    const result = await callProc('environments.probe', { id: env.id })
    expect(result.ok).toBe(false)
    const audit = await callProc('vault.audit')
    const use = audit.find((r: any) => r.action === 'use')
    expect(use).toBeDefined()
    expect(use.secretName).toBe('probe-key')
    expect(use.actorId).toBe('u1')
  })

  it('probe tolerates a dangling secretId (secret row gone)', async () => {
    // simulate a dangling link: create linked to a REAL secret, then hard-delete
    // the secret row bypassing the app (audit FK cascades; env FK set-null is a
    // POSTGRES rule — bypass by dropping the constraint in this throwaway DB)
    const { postgres } = await import('./helpers/pg')
    const secret = await callProc('vault.create', { name: 'ghost-key', value: 'v', kind: 'ssh-key' })
    const env = await callProc('environments.create', { name: 'dangling', host: '127.0.0.1', port: '59999', username: 'u', secretId: secret.id })
    await postgres.unsafe('alter table tandem_environments drop constraint tandem_environments_secret_id_tandem_vault_secrets_id_fkey')
    await postgres.unsafe('delete from tandem_vault_secrets where id = $1', [secret.id])
    const result = await callProc('environments.probe', { id: env.id })
    expect(result.ok).toBe(false)
    const audit = await callProc('vault.audit')
    expect(audit.filter((r: any) => r.action === 'use')).toHaveLength(0)
  })

  it('probe without a linked secret audits nothing', async () => {
    const env = await callProc('environments.create', { name: 'probe-box2', host: '127.0.0.1', port: '59999', username: 'u' })
    await callProc('environments.probe', { id: env.id })
    const audit = await callProc('vault.audit')
    expect(audit.filter((r: any) => r.action === 'use')).toHaveLength(0)
  })
})
