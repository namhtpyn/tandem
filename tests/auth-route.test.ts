// auth [...].ts route: gates for sign-up closure, password disable, OIDC 404 —
// plus handler passthrough with a stubbed auth instance.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations, sqlClient } from '../server/db/index'
import { call } from './api-harness'

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('auth route gates', () => {
  it('blocks password sign-up once any user exists (403)', async () => {
    await sqlClient`insert into tandem_user (id, name, email, email_verified, created_at, updated_at, role)
      values ('u1', 'U', 'u@x.co', true, now(), now(), 'viewer')`
    await expect(call('../server/routes/auth/[...].ts', { method: 'POST', url: '/auth/sign-up/email', body: { email: 'a@b.co', password: 'pw12345678', name: 'A' } }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('404s OIDC endpoints when no provider is configured', async () => {
    await expect(call('../server/routes/auth/[...].ts', { method: 'GET', url: '/auth/oauth2/whatever' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('passes through to the auth handler for plain GETs (mocked auth instance)', async () => {
    const authMod = await import('../server/utils/auth')
    const inst = await authMod.getAuth()
    const originalHandler = inst.handler
    inst.handler = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      const { result, event } = await call('../server/routes/auth/[...].ts', { method: 'GET', url: '/auth/get-session' })
      expect(event.node.res.statusCode).toBe(200)
    }
    finally {
      inst.handler = originalHandler
    }
  })
})
