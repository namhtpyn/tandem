// Authenticated API tests: oidc PUT validation paths + settings PUT, using a
// stubbed session (getAuth().api.getSession) via module override.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import './helpers/pg'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import './api-harness'

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('PUT /api/oidc (authenticated via stubbed session)', () => {
  it('rejects an invalid payload (400)', async () => {
    const { call } = await import('./api-harness')
    await expect(call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: 'nope' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a bad issuer URL (400)', async () => {
    const { call } = await import('./api-harness')
    await expect(call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ label: 'X', issuer: 'not-a-url', clientId: 'c', clientSecret: 's' }] } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('requires a secret for new providers (400)', async () => {
    const { call } = await import('./api-harness')
    await expect(call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ label: 'X', issuer: 'https://x.example.com', clientId: 'c' }] } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('saves providers, keeps secret on edit, generates ids for new ones', async () => {
    const { call } = await import('./api-harness')
    const r1 = await call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c1', clientSecret: 's1' }] } })
    expect(r1.result).toEqual({ ok: true, count: 1 })
    const { getOidcProviders } = await import('../server/utils/oidc')
    const stored = await getOidcProviders()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toMatch(/^[0-9a-f-]{36}$/)

    // edit: same id, no secret -> stored secret kept
    const id = stored[0]!.id
    await call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ id, label: 'One!', issuer: 'https://one.example.com', clientId: 'c1b' }] } })
    const after = await getOidcProviders()
    expect(after[0]!.clientSecret).toBe('s1')
    expect(after[0]!.label).toBe('One!')
    expect(after[0]!.clientId).toBe('c1b')
  })

  it('GET returns providers with hasSecret, never the secret', async () => {
    const { call } = await import('./api-harness')
    await call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c1', clientSecret: 's1' }] } })
    const { result } = await call('../server/api/oidc/index.get.ts', { method: 'GET', url: '/api/oidc' })
    const body = result as { providers: Array<Record<string, unknown>> }
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0]).toMatchObject({ label: 'One', hasSecret: true })
    expect(JSON.stringify(body)).not.toContain('s1')
  })
})

describe('PUT /api/settings (authenticated via stubbed session)', () => {
  it('rejects invalid payload (400)', async () => {
    const { call } = await import('./api-harness')
    await expect(call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: { disablePasswordLogin: 'yes' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects disabling password login with no provider (400)', async () => {
    const { call } = await import('./api-harness')
    await expect(call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: { disablePasswordLogin: true } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('toggles and persists disablePasswordLogin', async () => {
    const { call } = await import('./api-harness')
    await call('../server/api/oidc/index.put.ts', { method: 'PUT', url: '/api/oidc', body: { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c', clientSecret: 's' }] } })
    const { result } = await call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: { disablePasswordLogin: true } })
    expect(result).toEqual({ ok: true })
    const { getSettings } = await import('../server/utils/settings')
    expect(await getSettings()).toEqual({ disablePasswordLogin: true })
    // and back
    await call('../server/api/settings/index.put.ts', { method: 'PUT', url: '/api/settings', body: { disablePasswordLogin: false } })
    expect(await getSettings()).toEqual({ disablePasswordLogin: false })
  })

  it('GET returns current settings', async () => {
    const { call } = await import('./api-harness')
    const { result } = await call('../server/api/settings/index.get.ts', { method: 'GET', url: '/api/settings' })
    expect(result).toEqual({ disablePasswordLogin: false })
  })
})
