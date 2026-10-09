// auth: policy resolution, instance caching/rebuild, admin seed path
import { describe, expect, it, beforeEach } from 'vitest'
import './helpers/pg'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { resolveAuthPolicy, anyUserExists, getAuth, rebuildAuth } from '../server/utils/auth'
import { saveOidcProviders } from '../server/utils/oidc'
import { setSetting } from '../server/utils/settings'
import { hashPassword } from '../server/utils/auth-hash'
import { db } from '../server/db/index'
import { user, account } from '../server/db/schema'

describe('auth policy', () => {
  beforeEach(async () => {
    await resetSchema()
    await applyMigrations()
    delete process.env.TANDEM_DISABLE_PASSWORD_LOGIN
    await saveOidcProviders([])
  })

  it('password-only when no providers configured', async () => {
    const p = await resolveAuthPolicy()
    expect(p.passwordEnabled).toBe(true)
    expect(p.oidcEnabled).toBe(false)
    expect(p.oidcProviders).toEqual([])
  })

  it('oidc enabled when a provider is stored', async () => {
    await saveOidcProviders([{
      id: 'p1', label: 'One', issuer: 'https://one.example.com', clientId: 'c', clientSecret: 's',
    }])
    const p = await resolveAuthPolicy()
    expect(p.oidcEnabled).toBe(true)
    expect(p.passwordEnabled).toBe(true)
  })

  it('password disabled when policy set AND provider exists', async () => {
    await saveOidcProviders([{
      id: 'p1', label: 'One', issuer: 'https://one.example.com', clientId: 'c', clientSecret: 's',
    }])
    await setSetting('disablePasswordLogin', 'true')
    const p = await resolveAuthPolicy()
    expect(p.passwordEnabled).toBe(false)
  })

  it('env TANDEM_DISABLE_PASSWORD_LOGIN respected with env provider', async () => {
    const { deleteSetting } = await import('../server/utils/settings')
    await deleteSetting('oidc_providers')
    process.env.TANDEM_OIDC_ISSUER = 'https://env.example.com'
    process.env.TANDEM_OIDC_CLIENT_ID = 'env-client'
    process.env.TANDEM_OIDC_CLIENT_SECRET = 'env-secret'
    process.env.TANDEM_DISABLE_PASSWORD_LOGIN = 'true'
    try {
      const p = await resolveAuthPolicy()
      expect(p.passwordEnabled).toBe(false)
      expect(p.oidcEnabled).toBe(true)
    }
    finally {
      delete process.env.TANDEM_OIDC_ISSUER
      delete process.env.TANDEM_OIDC_CLIENT_ID
      delete process.env.TANDEM_OIDC_CLIENT_SECRET
      delete process.env.TANDEM_DISABLE_PASSWORD_LOGIN
    }
  })
})

describe('auth instance', () => {
  beforeEach(async () => {
    await resetSchema()
    await applyMigrations()
    await saveOidcProviders([])
  })

  it('builds and caches; rebuild swaps when policy changes', async () => {
    const a = await getAuth()
    const b = await getAuth()
    expect(a).toBe(b) // cached
    await rebuildAuth()
    const c = await getAuth()
    expect(c).not.toBe(a) // rebuilt
  })

  it('rebuilds implicitly when the provider set changes', async () => {
    const a = await getAuth()
    await saveOidcProviders([{
      id: 'p1', label: 'One', issuer: 'https://one.example.com', clientId: 'c', clientSecret: 's',
    }])
    const b = await getAuth()
    expect(b).not.toBe(a)
  })

  it('anyUserExists tracks the user table', async () => {
    expect(await anyUserExists()).toBe(false)
    await db.insert(user).values({
      id: 'u1', name: 'U', email: 'u@x.co', emailVerified: true, createdAt: new Date(), updatedAt: new Date(), role: 'viewer',
    })
    expect(await anyUserExists()).toBe(true)
  })
})

describe('hashPassword (better-auth compatible)', () => {
  it('produces a scrypt string better-auth verifies', async () => {
    const hash = await hashPassword('secret-pw')
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
    // round-trip through better-auth's verifier
    const { verifyPassword } = await import('better-auth/crypto')
    expect(await verifyPassword({ hash, password: 'secret-pw' })).toBe(true)
    expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false)
  })
})


describe('auth baseURL env branch', () => {
  it('honors BETTER_AUTH_URL when set', async () => {
    process.env.BETTER_AUTH_URL = 'https://auth.example.com'
    try {
      await rebuildAuth()
      const { getAuth } = await import('../server/utils/auth')
      const auth = await getAuth()
      expect((auth.options as { baseURL?: string }).baseURL).toBe('https://auth.example.com')
    }
    finally {
      delete process.env.BETTER_AUTH_URL
      await rebuildAuth()
    }
  })
})
