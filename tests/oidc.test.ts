// OIDC registry: storage round-trip, env fallback, validation failures
import { describe, expect, it, beforeEach } from 'vitest'
import './helpers/pg'
import { getOidcProviders, saveOidcProviders } from '../server/utils/oidc'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

describe('oidc registry', () => {
  beforeEach(async () => {
    await resetSchema()
    await applyMigrations()
  })

  it('is empty when nothing stored and no env', async () => {
    delete process.env.TANDEM_OIDC_ISSUER
    expect(await getOidcProviders()).toEqual([])
  })

  it('falls back to env provider when nothing stored', async () => {
    process.env.TANDEM_OIDC_ISSUER = 'https://env.example.com'
    process.env.TANDEM_OIDC_CLIENT_ID = 'env-client'
    process.env.TANDEM_OIDC_CLIENT_SECRET = 'env-secret'
    process.env.TANDEM_OIDC_LABEL = 'EnvSSO'
    try {
      const providers = await getOidcProviders()
      expect(providers).toEqual([{
        id: 'oidc',
        label: 'EnvSSO',
        issuer: 'https://env.example.com',
        clientId: 'env-client',
        clientSecret: 'env-secret',
      }])
    }
    finally {
      delete process.env.TANDEM_OIDC_ISSUER
      delete process.env.TANDEM_OIDC_CLIENT_ID
      delete process.env.TANDEM_OIDC_CLIENT_SECRET
      delete process.env.TANDEM_OIDC_LABEL
    }
  })

  it('save + get round-trips providers (stored wins over env)', async () => {
    await saveOidcProviders([{
      id: 'p1', label: 'One', issuer: 'https://one.example.com', clientId: 'c1', clientSecret: 's1',
    }])
    process.env.TANDEM_OIDC_ISSUER = 'https://env.example.com'
    process.env.TANDEM_OIDC_CLIENT_ID = 'env-client'
    process.env.TANDEM_OIDC_CLIENT_SECRET = 'env-secret'
    try {
      const providers = await getOidcProviders()
      expect(providers).toHaveLength(1)
      expect(providers[0]!.id).toBe('p1')
    }
    finally {
      delete process.env.TANDEM_OIDC_ISSUER
      delete process.env.TANDEM_OIDC_CLIENT_ID
      delete process.env.TANDEM_OIDC_CLIENT_SECRET
    }
  })

  it('ignores a corrupted stored registry and falls through to env', async () => {
    const { setSetting } = await import('../server/utils/settings')
    await setSetting('oidc_providers', 'not json {{{')
    process.env.TANDEM_OIDC_ISSUER = 'https://env.example.com'
    process.env.TANDEM_OIDC_CLIENT_ID = 'env-client'
    process.env.TANDEM_OIDC_CLIENT_SECRET = 'env-secret'
    try {
      const providers = await getOidcProviders()
      expect(providers).toHaveLength(1)
      expect(providers[0]!.issuer).toBe('https://env.example.com')
    }
    finally {
      delete process.env.TANDEM_OIDC_ISSUER
      delete process.env.TANDEM_OIDC_CLIENT_ID
      delete process.env.TANDEM_OIDC_CLIENT_SECRET
    }
  })

  it('ignores a stored registry failing schema validation', async () => {
    const { setSetting } = await import('../server/utils/settings')
    // valid JSON, but issuer is not a URL
    await setSetting('oidc_providers', JSON.stringify([{ id: 'x', label: 'X', issuer: 'nope', clientId: 'c', clientSecret: 's' }]))
    expect(await getOidcProviders()).toEqual([])
  })
})
