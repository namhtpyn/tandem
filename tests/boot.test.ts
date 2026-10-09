// boot plugin: migrations + admin seed + already-seeded skip + hash failure path
import { describe, expect, it, beforeEach, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { sqlClient } from '../server/db/index'

const bootModule = () => import('../server/plugins/boot')

beforeEach(async () => {
  await resetSchema()
  const { applyMigrations } = await import('../server/db/index')
  await applyMigrations()
})

describe('boot plugin', () => {
  it('seeds the admin when no users exist', async () => {
    const mod = await bootModule()
    const plugin = mod.default as () => Promise<unknown>
    await plugin()
    const users = await sqlClient`select email, role from tandem_user`
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'admin@tandem.local', role: 'admin' })
    const accounts = await sqlClient`select provider_id, password from tandem_account`
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.password).toMatch(/^[0-9a-f]{32}:/)
  })

  it('seeds with ADMIN_EMAIL/ADMIN_PASSWORD overrides', async () => {
    process.env.ADMIN_EMAIL = 'root@corp.example'
    process.env.ADMIN_PASSWORD = 'sup3r-secret'
    try {
      const mod = await bootModule()
      await (mod.default as () => Promise<unknown>)()
      const users = await sqlClient`select email from tandem_user`
      expect(users[0]!.email).toBe('root@corp.example')
      const { verifyPassword } = await import('better-auth/crypto')
      const acct = (await sqlClient`select password from tandem_account`)[0]!
      expect(await verifyPassword({ hash: acct.password, password: 'sup3r-secret' })).toBe(true)
    }
    finally {
      delete process.env.ADMIN_EMAIL
      delete process.env.ADMIN_PASSWORD
    }
  })

  it('skips seeding when users already exist', async () => {
    await sqlClient`insert into tandem_user (id, name, email, email_verified, created_at, updated_at, role)
      values ('u-existing', 'Existing', 'e@x.co', true, now(), now(), 'viewer')`
    const mod = await bootModule()
    await (mod.default as () => Promise<unknown>)()
    const users = await sqlClient`select count(*)::int as n from tandem_user`
    expect(users[0]!.n).toBe(1)
    const accounts = await sqlClient`select count(*)::int as n from tandem_account`
    expect(accounts[0]!.n).toBe(0)
  })
})
