// model providers: seeds, save/remove, employee linkage validation
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null = admin) {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers()) as Record<string, unknown>
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  context.session = sessionUser ? { user: sessionUser } : null
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

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  // FK targets for createdBy / session user
  const { db } = await dbm()
  const { user } = await import('../server/db/schema')
  await db.insert(user).values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: 'admin', title: 'T' })
})

describe('providers', () => {
  it('seeds openai, anthropic, openrouter with models', async () => {
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    const rows = snap.value as any[]
    const labels = rows.map(r => r.label).sort()
    expect(labels).toEqual(['Anthropic', 'OpenAI', 'OpenRouter'])
    const openai = rows.find(r => r.label === 'OpenAI')!
    expect(openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(openai.modelNames).toContain('gpt-5.2')
    const anthropic = rows.find(r => r.label === 'Anthropic')!
    expect(anthropic.apiStyle).toBe('anthropic')
    expect(anthropic.modelNames).toContain('claude-sonnet-4-5')
  })

  it('save upserts a provider and replaces its model list', async () => {
    const r1 = await callProc('providers.save', { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiStyle: 'openai', modelNames: ['llama-4', 'mixtral'] })
    expect(r1.id).toBeTruthy()
    // update: replace models
    await callProc('providers.save', { id: r1.id, label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiStyle: 'openai', modelNames: ['llama-4-only'] })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    const groq = (snap.value as any[]).find((p: any) => p.id === r1.id)!
    expect(groq.modelNames).toEqual(['llama-4-only'])
  })

  it('fetchModels lists + dedupes from an openai-style endpoint', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Record<string, string> })?.headers ?? {}
      if (headers.Authorization !== 'Bearer sk-test') throw new Error('missing auth')
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 'm-a' }, { id: '' }, {}] }) }
    }) as typeof fetch
    try {
      const r = await callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai', key: 'sk-test' })
      expect(r.models).toEqual(['m-a', 'm-b'])
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels uses x-api-key + version for anthropic style; maps errors', async () => {
    const origFetch = globalThis.fetch
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.push(((init as { headers?: Record<string, string> })?.headers) ?? {})
      return { ok: false, status: 401, json: async () => ({}) }
    }) as typeof fetch
    try {
      await expect(callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com', apiStyle: 'anthropic', key: 'sk-ant' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(seen[0]!['x-api-key']).toBe('sk-ant')
      expect(seen[0]!['anthropic-version']).toBe('2023-06-01')
      await expect(callProc('providers.fetchModels', { baseUrl: 'https://unreachable.invalid', apiStyle: 'openai' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels follows anthropic pagination (has_more + last_id)', async () => {
    const origFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (url: unknown) => {
      calls++
      const u = String(url)
      if (!u.includes('after_id=')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-early' }], has_more: true, last_id: 'm-early' }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-late' }], has_more: false, last_id: 'm-late' }) }
    }) as typeof fetch
    try {
      const r = await callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com', apiStyle: 'anthropic', key: 'sk-ant' })
      expect(r.models).toEqual(['m-early', 'm-late'])
      expect(calls).toBe(2)
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels uses a vault secret (decrypted server-side, audited use)', async () => {
    const sec = await callProc('vault.create', { name: 'sync-key', value: 'sk-from-vault' })
    const origFetch = globalThis.fetch
    const seenHeaders: Array<Record<string, string>> = []
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seenHeaders.push(((init as { headers?: Record<string, string> })?.headers) ?? {})
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'vault-model' }], has_more: false }) }
    }) as typeof fetch
    try {
      const r = await callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai', keySecretId: sec.id })
      expect(r.models).toEqual(['vault-model'])
      expect(seenHeaders[0]!.Authorization).toBe('Bearer sk-from-vault')
      // audit trail recorded the use
      const { db } = await dbm()
      const { vaultAudit } = await import('../server/db/schema')
      const audits = await db.select().from(vaultAudit).where(eq(vaultAudit.secretId, sec.id))
      expect(audits.some(a => a.action === 'use')).toBe(true)
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels pasted key wins over vault secret', async () => {
    const sec = await callProc('vault.create', { name: 'lose-key', value: 'sk-from-vault' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      const h = ((init as { headers?: Record<string, string> })?.headers) ?? {}
      expect(h.Authorization).toBe('Bearer sk-pasted')
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'x' }], has_more: false }) }
    }) as typeof fetch
    try {
      await callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai', key: 'sk-pasted', keySecretId: sec.id })
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels unknown vault secret rejected', async () => {
    await expect(callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai', keySecretId: 'ghost-sec' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('fetchModels tolerates a malformed body (no data array)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) })) as typeof fetch
    try {
      const r = await callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai' })
      expect(r.models).toEqual([])
    }
    finally { globalThis.fetch = origFetch }
  })

  it('fetchModels wraps network failures', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    try {
      await expect(callProc('providers.fetchModels', { baseUrl: 'https://fake.example.com/v1', apiStyle: 'openai' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'could not reach the endpoint' })
    }
    finally { globalThis.fetch = origFetch }
  })

  it('save with extraHeaders set (truthy arm)', async () => {
    const r = await callProc('providers.save', { label: 'Hdr', baseUrl: 'https://hdr.example.com/v1', apiStyle: 'openai', extraHeaders: { 'HTTP-Referer': 'https://tandem.local' }, modelNames: ['m'] })
    expect(r.id).toBeTruthy()
  })

  it('save with no headers and empty model list (empty branches)', async () => {
    const a = await callProc('providers.save', { label: 'Bare', baseUrl: 'https://bare.example.com/v1', apiStyle: 'openai', modelNames: [] })
    expect(a.id).toBeTruthy()
    const b = await callProc('providers.save', { label: 'Bare2', baseUrl: 'https://bare2.example.com/v1', apiStyle: 'openai' })
    expect(b.id).toBeTruthy()
  })

  it('live parses stored extraHeaders JSON', async () => {
    await callProc('providers.save', { label: 'HdrRead', baseUrl: 'https://hr.example.com/v1', apiStyle: 'openai', extraHeaders: { 'X-Probe': '1' }, modelNames: ['m'] })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    const p = (snap.value as any[]).find(r => r.label === 'HdrRead')!
    expect(p.extraHeaders).toEqual({ 'X-Probe': '1' })
  })

  it('providerInUse false when unreferenced', async () => {
    const { providerInUse } = await import('../server/utils/model-providers')
    expect(await providerInUse('seed-anthropic')).toBe(false)
  })

  it('save dedupes model names', async () => {
    const r = await callProc('providers.save', { label: 'Dup', baseUrl: 'https://dup.example.com/v1', apiStyle: 'openai', modelNames: ['m', 'm', 'm2'] })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    const dup = (snap.value as any[]).find((p: any) => p.id === r.id)!
    expect(dup.modelNames).toEqual(['m', 'm2'])
  })

  it('remove deletes an unused provider (models cascade)', async () => {
    const r = await callProc('providers.save', { label: 'Temp', baseUrl: 'https://temp.example.com/v1', apiStyle: 'openai', modelNames: ['t1'] })
    await callProc('providers.remove', { id: r.id })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    expect((snap.value as any[]).find((p: any) => p.id === r.id)).toBeUndefined()
    const { db } = await dbm()
    const { models } = await import('../server/db/schema')
    expect((await db.select().from(models)).filter(m => m.providerId === r.id)).toHaveLength(0)
  })

  it('remove is blocked while an AI employee uses the provider', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-p', name: 'env-p', host: '127.0.0.1', port: '22', username: 'u' })
    await callProc('employees.create', { name: 'P Bot', email: 'pbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-p', providerId: 'seed-openai' })
    await expect(callProc('providers.remove', { id: 'seed-openai' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('employees model access', () => {
  it('create/update persist providerId + modelId + apiKeySecretId', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-m', name: 'env-m', host: '127.0.0.1', port: '22', username: 'u' })
    const { models } = await import('../server/db/schema')
    const gpt = (await db.select().from(models)).find(m => m.name === 'gpt-5.2')!
    const sec = await callProc('vault.create', { name: 'bot-key', value: 'sk-test-123' })
    const bot = await callProc('employees.create', { name: 'M Bot', email: 'mbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-m', providerId: 'seed-openai', modelId: gpt.id, apiKeySecretId: sec.id })
    const { aiEmployees } = await import('../server/db/schema')
    let ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBe('seed-openai')
    expect(ai.modelId).toBe(gpt.id)
    expect(ai.apiKeySecretId).toBe(sec.id)
    // update: clear them
    await callProc('employees.update', { id: bot.id, name: 'M Bot', title: 'B', supervisorIds: [], providerId: null, modelId: null, apiKeySecretId: null })
    ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBeNull()
    expect(ai.modelId).toBeNull()
    expect(ai.apiKeySecretId).toBeNull()
  })

  it('create-path reject arms (model + secret variants)', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-c2', name: 'env-c2', host: '127.0.0.1', port: '22', username: 'u' })
    const sec = await callProc('vault.create', { name: 'real-key', value: 'sk-1' })
    // valid secret but ghost provider
    await expect(callProc('employees.create', { name: 'C2', email: 'c2a@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-c2', providerId: 'ghost', apiKeySecretId: sec.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // valid provider but ghost model
    await expect(callProc('employees.create', { name: 'C2', email: 'c2b@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-c2', providerId: 'seed-openai', modelId: 'ghost-model' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects unknown provider / model / secret', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-x', name: 'env-x', host: '127.0.0.1', port: '22', username: 'u' })
    await expect(callProc('employees.create', { name: 'X', email: 'x1@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-x', providerId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.create', { name: 'X', email: 'x2@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-x', apiKeySecretId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const bot = await callProc('employees.create', { name: 'X', email: 'x3@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-x' })
    await expect(callProc('employees.update', { id: bot.id, name: 'X', title: 'B', supervisorIds: [], modelId: 'ghost-model' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('update null-clear paths: provider null skips validation', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-n', name: 'env-n', host: '127.0.0.1', port: '22', username: 'u' })
    const bot = await callProc('employees.create', { name: 'N Bot', email: 'nbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-n', providerId: 'seed-openai' })
    // unknown values throw on the update path
    await expect(callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], providerId: 'seed-openai', modelId: 'ghost-model' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], apiKeySecretId: 'ghost-sec' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // null clears without hitting the existence checks
    await callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], providerId: null, modelId: null, apiKeySecretId: null })
    const { aiEmployees } = await import('../server/db/schema')
    const ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBeNull()
    expect(ai.modelId).toBeNull()
    expect(ai.apiKeySecretId).toBeNull()
  })

  it('update rejects unknown provider / secret (update-path validation)', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-u', name: 'env-u', host: '127.0.0.1', port: '22', username: 'u' })
    const bot = await callProc('employees.create', { name: 'U Bot', email: 'ubot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-u' })
    await expect(callProc('employees.update', { id: bot.id, name: 'U Bot', title: 'B', supervisorIds: [], providerId: 'ghost-prov' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.update', { id: bot.id, name: 'U Bot', title: 'B', supervisorIds: [], apiKeySecretId: 'ghost-sec' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('update-path model + secret reject arms in isolation', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-iso', name: 'env-iso', host: '127.0.0.1', port: '22', username: 'u' })
    const bot = await callProc('employees.create', { name: 'Iso', email: 'iso@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-iso' })
    await expect(callProc('employees.update', { id: bot.id, name: 'Iso', title: 'B', supervisorIds: [], modelId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.update', { id: bot.id, name: 'Iso', title: 'B', supervisorIds: [], apiKeySecretId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('update-path happy arms: valid model + secret pass checks', async () => {
    const { db } = await dbm()
    const { environments, models } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-h', name: 'env-h', host: '127.0.0.1', port: '22', username: 'u' })
    const gpt = (await db.select().from(models)).find(m => m.name === 'gpt-5.2')!
    const sec = await callProc('vault.create', { name: 'happy-key', value: 'sk-9' })
    const bot = await callProc('employees.create', { name: 'H Bot', email: 'hbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-h' })
    await callProc('employees.update', { id: bot.id, name: 'H Bot', title: 'B', supervisorIds: [], providerId: 'seed-openai', modelId: gpt.id, apiKeySecretId: sec.id })
    const { aiEmployees } = await import('../server/db/schema')
    const ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.modelId).toBe(gpt.id)
    expect(ai.apiKeySecretId).toBe(sec.id)
  })

  it('deleting the key secret nulls the agent reference (set null)', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-s', name: 'env-s', host: '127.0.0.1', port: '22', username: 'u' })
    const sec = await callProc('vault.create', { name: 'gone-key', value: 'sk-gone' })
    const bot = await callProc('employees.create', { name: 'S Bot', email: 'sbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-s', apiKeySecretId: sec.id })
    await callProc('vault.remove', { id: sec.id })
    const { aiEmployees } = await import('../server/db/schema')
    const ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.apiKeySecretId).toBeNull()
    expect(bot.id).toBeTruthy()
  })
})
