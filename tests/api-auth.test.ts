// oRPC settings/oidc procedures (authenticated via stubbed session): validation
// paths, secret handling, live snapshots — replaces the old REST handler tests.
import { describe, expect, it, beforeEach } from 'vitest'
import './helpers/pg'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import './api-harness'

const admin = { user: { id: 'test-admin', name: 'Test Admin', email: 'test@tandem.local', role: 'admin' } }

async function proc(path: string[], input?: unknown) {
  const { router, buildServerContext } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const k of path) node = node[k] as Record<string, unknown>
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => admin
  return (node['~orpc'] as { handler: (o: unknown) => Promise<unknown> }).handler({ input, context, signal: new AbortController().signal })
}

/** Through RPCHandler — validation errors map to ORPCError codes (400s). */
async function rpc(path: string, input?: unknown) {
  const { RPCHandler } = await import('@orpc/server/fetch')
  const { router } = await import('../server/utils/orpc')
  const handler = new RPCHandler(router)
  const req = new Request(`http://x/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input ?? null }),
  })
  const { response } = await handler.handle(req, { prefix: '/rpc', context: { getSession: async () => admin } })
  const body = await response!.json() as { json?: { code?: string } | { ok?: boolean } & Record<string, unknown> }
  if (!response!.ok) {
    const err = body.json as { code?: string } | undefined
    throw Object.assign(new Error(err?.code ?? 'BAD_REQUEST'), { code: err?.code })
  }
  return body.json
}

async function firstSnapshot(path: string[]) {
  const gen = await proc(path) as AsyncGenerator<unknown>
  const first = (await gen.next()).value
  await gen.return?.()
  return first
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('oidc.replace (authenticated)', () => {
  it('rejects an invalid payload (BAD_REQUEST)', async () => {
    await expect(rpc('oidc/replace', { providers: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects a bad issuer URL (BAD_REQUEST)', async () => {
    await expect(rpc('oidc/replace', { providers: [{ label: 'X', issuer: 'not-a-url', clientId: 'c', clientSecret: 's' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects more than 10 providers (BAD_REQUEST)', async () => {
    const providers = Array.from({ length: 11 }, (_, i) => ({ label: `P${i}`, issuer: 'https://x.example.com', clientId: 'c', clientSecret: 's' }))
    await expect(rpc('oidc/replace', { providers })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('requires a secret for new providers (BAD_REQUEST)', async () => {
    await expect(proc(['oidc', 'replace'], { providers: [{ label: 'X', issuer: 'https://x.example.com', clientId: 'c' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('saves providers, keeps secret on edit, generates ids for new ones', async () => {
    const r1 = await proc(['oidc', 'replace'], { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c1', clientSecret: 's1' }] }) as { ok: boolean, count: number }
    expect(r1).toEqual({ ok: true, count: 1 })
    const { getOidcProviders } = await import('../server/utils/oidc')
    const stored = await getOidcProviders()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toMatch(/^[0-9a-f-]{36}$/)

    // edit: same id, no secret -> stored secret kept
    const id = stored[0]!.id
    await proc(['oidc', 'replace'], { providers: [{ id, label: 'One!', issuer: 'https://one.example.com', clientId: 'c1b' }] })
    const after = await getOidcProviders()
    expect(after[0]!.clientSecret).toBe('s1')
    expect(after[0]!.label).toBe('One!')
    expect(after[0]!.clientId).toBe('c1b')
  })

  it('live snapshot returns providers with hasSecret, never the secret', async () => {
    await proc(['oidc', 'replace'], { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c1', clientSecret: 's1' }] })
    const snap = await firstSnapshot(['oidc', 'live']) as Array<Record<string, unknown>>
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ label: 'One', hasSecret: true })
    expect(JSON.stringify(snap)).not.toContain('s1')
  })
})

describe('settings.update (authenticated)', () => {
  it('rejects invalid payload (BAD_REQUEST)', async () => {
    await expect(rpc('settings/update', { disablePasswordLogin: 'yes' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects disabling password login with no provider (BAD_REQUEST)', async () => {
    await expect(proc(['settings', 'update'], { disablePasswordLogin: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('toggles and persists disablePasswordLogin', async () => {
    await proc(['oidc', 'replace'], { providers: [{ label: 'One', issuer: 'https://one.example.com', clientId: 'c', clientSecret: 's' }] })
    const r = await proc(['settings', 'update'], { disablePasswordLogin: true }) as { ok: boolean }
    expect(r).toEqual({ ok: true })
    const { getSettings } = await import('../server/utils/settings')
    expect(await getSettings()).toEqual({ disablePasswordLogin: true, companyName: 'Tandem' })
    // and back
    await proc(['settings', 'update'], { disablePasswordLogin: false })
    expect(await getSettings()).toEqual({ disablePasswordLogin: false, companyName: 'Tandem' })
  })

  it('live snapshot returns current settings', async () => {
    const snap = await firstSnapshot(['settings', 'live']) as { disablePasswordLogin: boolean }
    expect(snap).toEqual({ disablePasswordLogin: false, companyName: 'Tandem' })
  })
})

describe('auth.configLive (public snapshot content)', () => {
  it('reflects providers and password policy live', async () => {
    await proc(['oidc', 'replace'], { providers: [{ label: 'SSO', issuer: 'https://sso.example.com', clientId: 'c', clientSecret: 's' }] })
    const { router, buildServerContext } = await import('../server/utils/orpc')
    let node: Record<string, unknown> = router as unknown as Record<string, unknown>
    for (const k of ['auth', 'configLive']) node = node[k] as Record<string, unknown>
    const gen = await (node['~orpc'] as { handler: (o: unknown) => Promise<AsyncGenerator<unknown>> }).handler({ input: undefined, context: buildServerContext(new Headers()), signal: new AbortController().signal })
    const snap = (await gen.next()).value as { passwordEnabled: boolean, oidcEnabled: boolean, providers: Array<{ label: string }> }
    await gen.return?.()
    expect(snap.oidcEnabled).toBe(true)
    expect(snap.providers).toEqual([{ id: expect.any(String), label: 'SSO' }])
  })
})
