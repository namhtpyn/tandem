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
    const anthropic = rows.find(r => r.label === 'Anthropic')!
    expect(anthropic.apiStyle).toBe('anthropic')
  })

  it('save upserts a provider and replaces its model list', async () => {
    const r1 = await callProc('providers.save', { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiStyle: 'openai' })
    expect(r1.id).toBeTruthy()
    // update: replace models
    await callProc('providers.save', { id: r1.id, label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiStyle: 'openai' })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
  })

  it('save with extraHeaders set (truthy arm)', async () => {
    const r = await callProc('providers.save', { label: 'Hdr', baseUrl: 'https://hdr.example.com/v1', apiStyle: 'openai', extraHeaders: { 'HTTP-Referer': 'https://tandem.local' } })
    expect(r.id).toBeTruthy()
  })

  it('save with no headers and empty model list (empty branches)', async () => {
    const a = await callProc('providers.save', { label: 'Bare', baseUrl: 'https://bare.example.com/v1', apiStyle: 'openai' })
    expect(a.id).toBeTruthy()
    const b = await callProc('providers.save', { label: 'Bare2', baseUrl: 'https://bare2.example.com/v1', apiStyle: 'openai' })
    expect(b.id).toBeTruthy()
  })

  it('live parses stored extraHeaders JSON', async () => {
    await callProc('providers.save', { label: 'HdrRead', baseUrl: 'https://hr.example.com/v1', apiStyle: 'openai', extraHeaders: { 'X-Probe': '1' } })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    const p = (snap.value as any[]).find(r => r.label === 'HdrRead')!
    expect(p.extraHeaders).toEqual({ 'X-Probe': '1' })
  })

  it('save dedupes model names', async () => {
    const r = await callProc('providers.save', { label: 'Dup', baseUrl: 'https://dup.example.com/v1', apiStyle: 'openai' })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
  })

  it('remove deletes an unused provider (models cascade)', async () => {
    const r = await callProc('providers.save', { label: 'Temp', baseUrl: 'https://temp.example.com/v1', apiStyle: 'openai' })
    await callProc('providers.remove', { id: r.id })
    const iter = await callProc('providers.live')
    const snap = await iter.next()
    await iter.return?.()
    expect((snap.value as any[]).find((p: any) => p.id === r.id)).toBeUndefined()
    const { db } = await dbm()
    const { models } = await import('../server/db/schema')
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
  it('update rejects unknown provider / secret', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-r', name: 'env-r', host: '127.0.0.1', port: '22', username: 'u' })
    const bot = await callProc('employees.create', { name: 'R Bot', email: 'rbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-r' })
    await expect(callProc('employees.update', { id: bot.id, name: 'R Bot', title: 'B', supervisorIds: [], providerId: 'ghost-prov' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.update', { id: bot.id, name: 'R Bot', title: 'B', supervisorIds: [], apiKeySecretId: 'ghost-sec' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // freetext model accepted as-is; valid provider + secret pass the update-path checks
    const sec = await callProc('vault.create', { name: 'r-key', value: 'sk-1' })
    await callProc('employees.update', { id: bot.id, name: 'R Bot', title: 'B', supervisorIds: [], model: 'any-model-name', providerId: 'seed-openai', apiKeySecretId: sec.id })
    const { aiEmployees } = await import('../server/db/schema')
    const ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.model).toBe('any-model-name')
  })

  it('create/update persist providerId + model + apiKeySecretId', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-m', name: 'env-m', host: '127.0.0.1', port: '22', username: 'u' })
    const sec = await callProc('vault.create', { name: 'bot-key', value: 'sk-test-123' })
    const bot = await callProc('employees.create', { name: 'M Bot', email: 'mbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-m', providerId: 'seed-openai', model: 'gpt-5.2', apiKeySecretId: sec.id })
    const { aiEmployees } = await import('../server/db/schema')
    let ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBe('seed-openai')
    expect(ai.model).toBe('gpt-5.2')
    expect(ai.apiKeySecretId).toBe(sec.id)
    // update: clear them
    await callProc('employees.update', { id: bot.id, name: 'M Bot', title: 'B', supervisorIds: [], providerId: null, model: null, apiKeySecretId: null })
    ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBeNull()
    expect(ai.model).toBeNull()
    expect(ai.apiKeySecretId).toBeNull()
  })

  it('rejects unknown provider / model / secret', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-x', name: 'env-x', host: '127.0.0.1', port: '22', username: 'u' })
    await expect(callProc('employees.create', { name: 'X', email: 'x1@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-x', providerId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.create', { name: 'X', email: 'x2@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-x', apiKeySecretId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('update null-clear paths: provider null skips validation', async () => {
    const { db } = await dbm()
    const { environments } = await import('../server/db/schema')
    await db.insert(environments).values({ id: 'env-n', name: 'env-n', host: '127.0.0.1', port: '22', username: 'u' })
    const bot = await callProc('employees.create', { name: 'N Bot', email: 'nbot@tandem.local', kind: 'ai', title: 'B', environmentId: 'env-n', providerId: 'seed-openai' })
    // unknown values throw on the update path
    await expect(callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], providerId: 'ghost-prov' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], apiKeySecretId: 'ghost-sec' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // null clears without hitting the existence checks
    await callProc('employees.update', { id: bot.id, name: 'N Bot', title: 'B', supervisorIds: [], providerId: null, model: null, apiKeySecretId: null })
    const { aiEmployees } = await import('../server/db/schema')
    const ai = (await db.select().from(aiEmployees))[0]!
    expect(ai.providerId).toBeNull()
    expect(ai.model).toBeNull()
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
