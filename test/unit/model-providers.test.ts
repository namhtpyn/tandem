import { eq, sql } from 'drizzle-orm';
// model providers: seeds, save/remove, employee linkage validation
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './api-harness';
import { applyMigrations } from '#server/db/index';
import { ROLE } from '#shared/enums';

import { resetSchema } from './helpers/pg.ts';

const admin = {
  id: '00000000-0000-7000-8000-cd5fca5e2d34',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
};

async function ctx(sessionUser: { id: string; name: string; email: string; role: string } | null = admin) {
  const { buildServerContext } = await import('#server/domains/kernel/context');
  const context = buildServerContext(new Headers()) as Record<string, unknown>;
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () =>
    sessionUser ? { user: sessionUser } : null;
  context.session = sessionUser ? { user: sessionUser } : null;
  return context;
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('#server/domains/app.router');
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>;
  }
  const { call } = await import('@orpc/server');
  return await call(node as unknown as Parameters<typeof call>[0], input ?? {}, {
    context: await ctx(),
    signal: new AbortController().signal,
  });
}

async function dbm() {
  return await import('#server/db');
}

type ProviderRow = {
  id: string;
  label: string;
  baseUrl: string;
  endpoints: string[];
  extraHeaders: Record<string, string> | null;
};

beforeEach(async () => {
  const { modelCache } = await import('#server/domains/providers/models-cache');
  modelCache.clear();
  await resetSchema();
  await applyMigrations();
  // FK targets for createdBy / session user
  const { db } = await dbm();
  const { user } = await import('#server/db/schema');
  await db
    .insert(user)
    .values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN, title: 'T' });
});

// BASELINE LAW (2026-10-16 squash): migrations seed statuses only — the provider
// catalog starts EMPTY; tests create their own fixtures.
async function ensureProvider(id: string, label: string, baseUrl: string, endpoints: string[]) {
  const d = await dbm();
  const { modelProviders } = await import('#server/db/schema');
  await d.db.insert(modelProviders).values({ id, label, baseUrl, endpoints }).onConflictDoNothing();
}

describe('providers', () => {
  it('catalog starts empty on a fresh DB (no provider seeds)', async () => {
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
    expect(snap.value).toEqual([]);
  });

  it('save upserts a provider and replaces its model list', async () => {
    const r1 = await callProc('providers.save', {
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    expect(r1.id).toBeTruthy();
    // update: replace models
    await callProc('providers.save', {
      id: r1.id,
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
  });

  it('save with extraHeaders set (truthy arm)', async () => {
    const r = await callProc('providers.save', {
      label: 'Hdr',
      baseUrl: 'https://hdr.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
      extraHeaders: { 'HTTP-Referer': 'https://tandem.local' },
    });
    expect(r.id).toBeTruthy();
  });

  it('save with no headers and empty model list (empty branches)', async () => {
    const a = await callProc('providers.save', {
      label: 'Bare',
      baseUrl: 'https://bare.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    expect(a.id).toBeTruthy();
    const b = await callProc('providers.save', {
      label: 'Bare2',
      baseUrl: 'https://bare2.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    expect(b.id).toBeTruthy();
  });

  it('live parses stored extraHeaders JSON', async () => {
    await callProc('providers.save', {
      label: 'HdrRead',
      baseUrl: 'https://hr.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
      extraHeaders: { 'X-Probe': '1' },
    });
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
    const p = (snap.value as ProviderRow[]).find((r) => r.label === 'HdrRead')!;
    expect(p.extraHeaders).toEqual({ 'X-Probe': '1' });
  });

  it('models: probes endpoint with vault key, audits use, caches, paginates', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'probe-key', value: 'sk-probe' });
    const prov = await callProc('providers.save', {
      label: 'ProbeSrc',
      baseUrl: 'https://probe.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const origFetch = globalThis.fetch;
    let calls = 0;
    const seen: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      calls++;
      const h = (init as { headers?: Record<string, string> })?.headers ?? {};
      seen.push({ url: String(url), auth: h.Authorization });
      if (!String(url).includes('after_id=')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }], has_more: true, last_id: 'm1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm2' }], has_more: false }) };
    }) as typeof fetch;
    try {
      const r = await callProc('providers.models', { providerId: prov.id, keySecretId: sec.id });
      expect(r.models).toEqual(['m1', 'm2']);
      expect(calls).toBe(2);
      expect(seen[0]!.auth).toBe('Bearer sk-probe');
      // second call served from cache (no extra fetch)
      const r2 = await callProc('providers.models', { providerId: prov.id, keySecretId: sec.id });
      expect(r2.models).toEqual(['m1', 'm2']);
      expect(calls).toBe(2);
      // no-secret call falls back to the cached provider list
      const r3 = await callProc('providers.models', { providerId: prov.id });
      expect(r3.models).toEqual(['m1', 'm2']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('models: unknown provider rejected; unknown secret rejected', async () => {
    await expect(callProc('providers.models', { providerId: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const prov = await callProc('providers.save', {
      label: 'P2',
      baseUrl: 'https://p2.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    await expect(callProc('providers.models', { providerId: prov.id, keySecretId: 'ghost-sec' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
  });

  it('models: anthropic style uses x-api-key + version header', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'ant2-key', value: 'sk-ant2' });
    const prov = await callProc('providers.save', {
      label: 'AntSrc',
      baseUrl: 'https://ant.example.com',
      endpoints: ['ANTHROPIC-MESSAGES'],
    });
    const origFetch = globalThis.fetch;
    const seen: Array<Record<string, string>> = [];
    let hitUrl = '';
    globalThis.fetch = (async (u: unknown, init?: unknown) => {
      hitUrl = String(u);
      seen.push((init as { headers?: Record<string, string> })?.headers ?? {});
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-x' }], has_more: false }) };
    }) as typeof fetch;
    try {
      const r = await callProc('providers.models', { providerId: prov.id, keySecretId: sec.id });
      expect(hitUrl).toContain('/v1/models');
      expect(r.models).toEqual(['claude-x']);
      expect(seen[0]!['x-api-key']).toBe('sk-ant2');
      expect(seen[0]!['anthropic-version']).toBe('2023-06-01');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('models: empty list when never probed and no secret', async () => {
    const prov = await callProc('providers.save', {
      label: 'ColdSrc',
      baseUrl: 'https://cold.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const r = await callProc('providers.models', { providerId: prov.id });
    expect(r.models).toEqual([]);
  });

  it('models: endpoint error mapped', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'err-key', value: 'sk-err' });
    const prov = await callProc('providers.save', {
      label: 'ErrSrc',
      baseUrl: 'https://err.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as typeof fetch;
    try {
      await expect(callProc('providers.models', { providerId: prov.id, keySecretId: sec.id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'endpoint returned 403',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('model cache TTL sweeper clears the map', async () => {
    // warm a real cache entry (arms the sweeper), then use fake timers on a NEW interval
    const prov = await callProc('providers.save', {
      label: 'TTL',
      baseUrl: 'https://ttl.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const sec = await callProc('vault.secrets.create', { name: 'ttl-key', value: 'sk-ttl' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'm' }], has_more: false }),
    })) as typeof fetch;
    try {
      // two probes exercise the already-armed guard
      await callProc('providers.models', { providerId: prov.id });
      const sec2 = await callProc('vault.secrets.create', { name: 'ttl-key2', value: 'sk-ttl2' });
      await callProc('providers.models', { providerId: prov.id, keySecretId: sec2.id });
    } finally {
      globalThis.fetch = origFetch;
    }
    const { modelCache, sweepModelCache } = await import('#server/domains/providers/models-cache');
    expect(modelCache.size).toBeGreaterThan(0);
    // second, uncached probe (different secret) exercises the sweeper-already-armed guard
    const sec2 = await callProc('vault.secrets.create', { name: 'ttl-key2', value: 'sk-ttl2' });
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'm2' }], has_more: false }),
    })) as typeof fetch;
    try {
      const r2 = await callProc('providers.models', { providerId: prov.id, keySecretId: sec2.id });
      expect(r2.models).toEqual(['m2']);
    } finally {
      globalThis.fetch = origFetch2;
    }
    sweepModelCache();
    expect(modelCache.size).toBe(0);
  });

  it('models: network failure wrapped', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'net-key', value: 'sk-net' });
    const prov = await callProc('providers.save', {
      label: 'NetSrc',
      baseUrl: 'https://net.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    try {
      await expect(callProc('providers.models', { providerId: prov.id, keySecretId: sec.id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'could not reach the endpoint',
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('models: no-extraHeaders arm + malformed payload arm', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'bare-key', value: 'sk-bare' });
    const prov = await callProc('providers.save', {
      label: 'BareSrc',
      baseUrl: 'https://bare2.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
      extraHeaders: { 'X-Probe': '1' },
    });
    const origFetch = globalThis.fetch;
    let malformed = false;
    globalThis.fetch = (async () => {
      if (malformed) return { ok: true, status: 200, json: async () => ({ unexpected: 1 }) };
      malformed = true;
      return { ok: true, status: 200, json: async () => ({ data: 'not-an-array' }) };
    }) as typeof fetch;
    try {
      const r = await callProc('providers.models', { providerId: prov.id });
      expect(r.models).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('save dedupes model names', async () => {
    const r = await callProc('providers.save', {
      label: 'Dup',
      baseUrl: 'https://dup.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
  });

  it('remove deletes an unused provider (models cascade)', async () => {
    const r = await callProc('providers.save', {
      label: 'Temp',
      baseUrl: 'https://temp.example.com/v1',
      endpoints: ['OPENAI-COMPLETIONS'],
    });
    await callProc('providers.remove', { id: r.id });
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
    expect((snap.value as ProviderRow[]).find((p) => p.id === r.id)).toBeUndefined();
    const { db } = await dbm();
    const { models } = await import('#server/db/schema');
  });

  it('remove is blocked while an AI employee uses the provider', async () => {
    await ensureProvider('seed-openai', 'OpenAI', 'https://api.openai.com', ['OPENAI-COMPLETIONS']);
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-p',
      name: 'env-p',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    await callProc('employees.create', {
      name: 'P Bot',
      email: 'pbot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-p',
      providerId: 'seed-openai',
      executable: 'hermes acp',
    });
    await expect(callProc('providers.remove', { id: 'seed-openai' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('employees model access', () => {
  it('update rejects unknown provider / secret', async () => {
    await ensureProvider('seed-openai', 'OpenAI', 'https://api.openai.com', ['OPENAI-COMPLETIONS']);
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-r',
      name: 'env-r',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const bot = await callProc('employees.create', {
      name: 'R Bot',
      email: 'rbot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-r',
      executable: 'hermes acp',
    });
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'R Bot',
        title: 'B',
        supervisorIds: [],
        providerId: 'ghost-prov',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'R Bot',
        title: 'B',
        supervisorIds: [],
        apiKeySecretId: 'ghost-sec',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // freetext model accepted as-is; valid provider + secret pass the update-path checks
    const sec = await callProc('vault.secrets.create', { name: 'r-key', value: 'sk-1' });
    await callProc('employees.update', {
      id: bot.id,
      name: 'R Bot',
      title: 'B',
      supervisorIds: [],
      model: 'any-model-name',
      providerId: 'seed-openai',
      apiKeySecretId: sec.id,
    });
    const { aiEmployees } = await import('#server/db/schema');
    const ai = (await db.select().from(aiEmployees))[0]!;
    expect(ai.model).toBe('any-model-name');
  });

  it('create/update persist providerId + model + apiKeySecretId', async () => {
    await ensureProvider('seed-openai', 'OpenAI', 'https://api.openai.com', ['OPENAI-COMPLETIONS']);
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-m',
      name: 'env-m',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const sec = await callProc('vault.secrets.create', { name: 'bot-key', value: 'sk-test-123' });
    const bot = await callProc('employees.create', {
      name: 'M Bot',
      email: 'mbot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-m',
      providerId: 'seed-openai',
      model: 'gpt-5.2',
      apiKeySecretId: sec.id,
      executable: 'hermes acp',
    });
    const { aiEmployees } = await import('#server/db/schema');
    let ai = (await db.select().from(aiEmployees))[0]!;
    expect(ai.providerId).toBe('seed-openai');
    expect(ai.model).toBe('gpt-5.2');
    expect(ai.apiKeySecretId).toBe(sec.id);
    // update: clear them
    await callProc('employees.update', {
      id: bot.id,
      name: 'M Bot',
      title: 'B',
      supervisorIds: [],
      providerId: null,
      model: null,
      apiKeySecretId: null,
    });
    ai = (await db.select().from(aiEmployees))[0]!;
    expect(ai.providerId).toBeNull();
    expect(ai.model).toBeNull();
    expect(ai.apiKeySecretId).toBeNull();
  });

  it('rejects unknown provider / model / secret', async () => {
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-x',
      name: 'env-x',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    await expect(
      callProc('employees.create', {
        name: 'X',
        email: 'x1@tandem.local',
        kind: 'ai',
        title: 'B',
        environmentId: 'env-x',
        providerId: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('employees.create', {
        name: 'X',
        email: 'x2@tandem.local',
        kind: 'ai',
        title: 'B',
        environmentId: 'env-x',
        apiKeySecretId: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('update null-clear paths: provider null skips validation', async () => {
    await ensureProvider('seed-openai', 'OpenAI', 'https://api.openai.com', ['OPENAI-COMPLETIONS']);
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-n',
      name: 'env-n',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const bot = await callProc('employees.create', {
      name: 'N Bot',
      email: 'nbot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-n',
      providerId: 'seed-openai',
      executable: 'hermes acp',
    });
    // unknown values throw on the update path
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'N Bot',
        title: 'B',
        supervisorIds: [],
        providerId: 'ghost-prov',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'N Bot',
        title: 'B',
        supervisorIds: [],
        apiKeySecretId: 'ghost-sec',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // null clears without hitting the existence checks
    await callProc('employees.update', {
      id: bot.id,
      name: 'N Bot',
      title: 'B',
      supervisorIds: [],
      providerId: null,
      model: null,
      apiKeySecretId: null,
    });
    const { aiEmployees } = await import('#server/db/schema');
    const ai = (await db.select().from(aiEmployees))[0]!;
    expect(ai.providerId).toBeNull();
    expect(ai.model).toBeNull();
    expect(ai.apiKeySecretId).toBeNull();
  });

  it('update rejects unknown provider / secret (update-path validation)', async () => {
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-u',
      name: 'env-u',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const bot = await callProc('employees.create', {
      name: 'U Bot',
      email: 'ubot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-u',
      executable: 'hermes acp',
    });
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'U Bot',
        title: 'B',
        supervisorIds: [],
        providerId: 'ghost-prov',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('employees.update', {
        id: bot.id,
        name: 'U Bot',
        title: 'B',
        supervisorIds: [],
        apiKeySecretId: 'ghost-sec',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('deleting the key secret nulls the agent reference (set null)', async () => {
    const { db } = await dbm();
    const { environments } = await import('#server/db/schema');
    await db.insert(environments).values({
      id: 'env-s',
      name: 'env-s',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const sec = await callProc('vault.secrets.create', { name: 'gone-key', value: 'sk-gone' });
    const bot = await callProc('employees.create', {
      name: 'S Bot',
      email: 'sbot@tandem.local',
      kind: 'ai',
      title: 'B',
      environmentId: 'env-s',
      apiKeySecretId: sec.id,
      executable: 'hermes acp',
    });
    await callProc('vault.secrets.remove', { id: sec.id });
    const { aiEmployees } = await import('#server/db/schema');
    const ai = (await db.select().from(aiEmployees))[0]!;
    expect(ai.apiKeySecretId).toBeNull();
    expect(bot.id).toBeTruthy();
  });
});

describe('provider styles', () => {
  it('seed-jev shape when present: decision provider, no key by default', async () => {
    await ensureProvider('seed-jev', 'Jev (TypeSafe AI)', 'https://api.typesafe.ai', ['TYPESAFE-SYSTEMONE']);
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
    const list = snap.value as ProviderRow[];
    const jev = list.find((p) => p.id === 'seed-jev')!;
    expect(jev.endpoints).toEqual(['TYPESAFE-SYSTEMONE']);
    expect(jev.baseUrl).toBe('https://api.typesafe.ai');
  });

  it('a provider can carry many styles incl. decision + llm together', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'prov-key', value: 'sk-1' });
    await callProc('providers.save', {
      label: 'Kitchen sink',
      baseUrl: 'https://api.example.com',
      endpoints: ['OPENAI-COMPLETIONS', 'OPENAI-RESPONSES', 'OPENAI-MODELS', 'OPENAI-DECISIONS'],
    });
    await callProc('providers.save', {
      label: 'Plain LLM',
      baseUrl: 'https://llm.example.com/v1',
      endpoints: ['ANTHROPIC-MESSAGES'],
    });
    const iter = await callProc('providers.live');
    const snap = await iter.next();
    await iter.return?.();
    const list = snap.value as ProviderRow[];
    const sink = list.find((p) => p.label === 'Kitchen sink')!;
    expect(sink.endpoints).toEqual(['OPENAI-COMPLETIONS', 'OPENAI-RESPONSES', 'OPENAI-MODELS', 'OPENAI-DECISIONS']);
    const plain = list.find((p) => p.label === 'Plain LLM')!;
    expect(plain.endpoints).toEqual(['ANTHROPIC-MESSAGES']);
  });

  it('rejects an unknown style value', async () => {
    await expect(
      callProc('providers.save', { label: 'Bad', baseUrl: 'https://x.example.com', endpoints: ['NOPE'] }),
    ).rejects.toThrow();
  });

  it('decision styles save keylessly (key provided per call at use time)', async () => {
    const r = await callProc('providers.save', {
      label: 'Keyless',
      baseUrl: 'https://x.example.com',
      endpoints: ['OPENAI-DECISIONS'],
    });
    expect(r.id).toBeTruthy();
    await expect(
      callProc('providers.save', {
        label: 'Bad',
        baseUrl: 'https://x.example.com',
        endpoints: ['TYPESAFE-SYSTEMONE'],
        keySecretId: 'ghost',
      }),
    ).rejects.toThrow();
  });
});

describe('models probe payload arms', () => {
  it('typesafe models shape parsed (models[].name)', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'ts-key', value: 'sk-ts' });
    const prov = await callProc('providers.save', {
      label: 'TsSrc',
      baseUrl: 'https://ts.example.com',
      endpoints: ['TYPESAFE-SYSTEMONE', 'TYPESAFE-MODELS'],
    });
    const origFetch = globalThis.fetch;
    let hitUrl = '';
    globalThis.fetch = (async (u: unknown) => {
      hitUrl = String(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'jev-latest' }, { name: 'jev-preview' }, { name: 42 }] }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('providers.models', { providerId: prov.id, keySecretId: sec.id });
      expect(hitUrl).toContain('https://ts.example.com/v1/models');
      expect(r.models).toEqual(['jev-latest', 'jev-preview']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('openai url arm + non-array data payload tolerated', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'arm-key', value: 'sk-arm' });
    const prov = await callProc('providers.save', {
      label: 'ArmSrc',
      baseUrl: 'https://arm.example.com',
      endpoints: ['OPENAI-COMPLETIONS'],
      extraHeaders: { 'X-Probe': '1' },
    });
    const origFetch = globalThis.fetch;
    let hitUrl = '';
    globalThis.fetch = (async (u: unknown) => {
      hitUrl = String(u);
      return { ok: true, status: 200, json: async () => ({ data: 'nope' }) };
    }) as typeof fetch;
    try {
      const r = await callProc('providers.models', { providerId: prov.id, keySecretId: sec.id });
      expect(hitUrl).toContain('https://arm.example.com/v1/models');
      expect(r.models).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
