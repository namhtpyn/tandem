// settings store: get/set/delete + typed getSettings
import { beforeEach, describe, expect, it } from 'vitest';

import './helpers/pg';
import { getSetting, setSetting, deleteSetting, getSettings } from '../server/domains/settings/settings.service';
import { postgres } from './helpers/pg';
import { ROLE } from '../shared/enums';

describe('settings store', () => {
  it('returns null for a missing key', async () => {
    expect(await getSetting('nope')).toBeNull();
  });

  it('set then get round-trips a value', async () => {
    await setSetting('k1', 'v1');
    expect(await getSetting('k1')).toBe('v1');
  });

  it('set twice updates in place (upsert)', async () => {
    await setSetting('k2', 'first');
    await setSetting('k2', 'second');
    expect(await getSetting('k2')).toBe('second');
    const rows = await postgres`select count(*)::int as n from settings where key = 'k2'`;
    expect(rows[0]!.n).toBe(1);
  });

  it('deleteSetting removes the row', async () => {
    await setSetting('k3', 'v3');
    await deleteSetting('k3');
    expect(await getSetting('k3')).toBeNull();
  });

  it('getSettings defaults disablePasswordLogin false + companyName Tandem', async () => {
    expect(await getSettings()).toEqual({
      disablePasswordLogin: false,
      companyName: 'Tandem',
      internalLlm: null,
      internalDecision: null,
      runTimeoutMs: 1_800_000,
      tasksPerAgent: 1,
      companyPrompt: '',
    });
  });

  it('getSettings reflects a stored true flag', async () => {
    await setSetting('disablePasswordLogin', 'true');
    expect(await getSettings()).toEqual({
      disablePasswordLogin: true,
      companyName: 'Tandem',
      internalLlm: null,
      internalDecision: null,
      runTimeoutMs: 1_800_000,
      tasksPerAgent: 1,
      companyPrompt: '',
    });
  });

  it('companyName round-trips via setSetting and trims on read', async () => {
    await setSetting('companyName', '  Ultranomic  ');
    const s = await getSettings();
    expect(s.companyName).toBe('Ultranomic');
  });

  it('companyName undefined in update leaves the stored value untouched', async () => {
    const { appRouter: router } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    await setSetting('companyName', 'Kept Name');
    const ctx = buildServerContext(new Headers());
    (ctx as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
      user: { id: '00000000-0000-7000-8000-c5ea71554c77', name: 'A', email: 'a@x', role: ROLE.ADMIN },
    });
    let cur: Record<string, unknown> = router as unknown as Record<string, unknown>;
    for (const k of ['settings', 'update']) cur = cur[k] as Record<string, unknown>;
    const node = cur['~orpc'] as { handler: (o: unknown) => Promise<unknown> };
    await node.handler({
      input: { disablePasswordLogin: false },
      context: {
        ...ctx,
        session: { user: { id: '00000000-0000-7000-8000-c5ea71554c77', name: 'A', email: 'a@x', role: ROLE.ADMIN } },
      },
      signal: new AbortController().signal,
    });
    expect((await getSettings()).companyName).toBe('Kept Name');
    // and with a value present it persists (trims)
    await node.handler({
      input: { companyName: '  New Name  ' },
      context: {
        ...ctx,
        session: { user: { id: '00000000-0000-7000-8000-c5ea71554c77', name: 'A', email: 'a@x', role: ROLE.ADMIN } },
      },
      signal: new AbortController().signal,
    });
    expect((await getSettings()).companyName).toBe('New Name');
  });

  it('blank companyName falls back to Tandem', async () => {
    await setSetting('companyName', '   ');
    expect((await getSettings()).companyName).toBe('Tandem');
  });
});

describe('settings: workspace ai assignments', () => {
  const admin = {
    id: '00000000-0000-7000-8000-cd5fca5e2d34',
    name: 'Admin',
    email: 'admin@tandem.local',
    role: ROLE.ADMIN,
  };

  beforeEach(async () => {
    const { db } = await import('../server/db');
    const { user } = await import('../server/db/schema');
    await db
      .insert(user)
      .values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN, title: 'T' })
      .onConflictDoNothing();
  });

  async function callProc(path: string, input?: unknown): Promise<any> {
    const { appRouter: router } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
    for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
    const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> };
    const context = buildServerContext(new Headers()) as Record<string, unknown>;
    (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin });
    context.session = { user: admin };
    return await internals.handler({ input, context, signal: new AbortController().signal });
  }

  it('internalDecision round-trips with provider + secret validation', async () => {
    const { modelProviders } = await import('../server/db/schema');
    const { db } = await import('../server/db');
    await db
      .insert(modelProviders)
      .values({ id: 'dec-1', label: 'Decider', baseUrl: 'https://dec.example.com', endpoints: ['TYPESAFE-SYSTEMONE'] })
      .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['TYPESAFE-SYSTEMONE'] } });
    const sec = await callProc('vault.secrets.create', { name: 'dec-key', value: 'sk-dec' });
    await callProc('settings.update', {
      internalDecision: { providerId: 'dec-1', model: 'jev-latest', keySecretId: sec.id },
    });
    const s = await getSettings();
    expect(s.internalDecision).toEqual({ providerId: 'dec-1', model: 'jev-latest', keySecretId: sec.id });
    await callProc('settings.update', { internalDecision: null });
    expect((await getSettings()).internalDecision).toBeNull();
  });

  it('rejects wrong-kind provider and ghost secret', async () => {
    const { modelProviders } = await import('../server/db/schema');
    const { db } = await import('../server/db');
    await db
      .insert(modelProviders)
      .values({ id: 'llm-1', label: 'Chatty', baseUrl: 'https://llm.example.com', endpoints: ['OPENAI-COMPLETIONS'] })
      .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['OPENAI-COMPLETIONS'] } });
    const sec = await callProc('vault.secrets.create', { name: 'llm-key', value: 'sk-llm' });
    await expect(
      callProc('settings.update', {
        internalDecision: { providerId: 'llm-1', model: 'jev-latest', keySecretId: sec.id },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('settings.update', { internalLlm: { providerId: 'llm-1', model: 'gpt-5.2', keySecretId: 'ghost' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callProc('settings.update', { internalLlm: { providerId: 'ghost', model: 'gpt-5.2', keySecretId: sec.id } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('assignment without a model parses to null (model required once provider is set)', async () => {
    const { modelProviders } = await import('../server/db/schema');
    const { db } = await import('../server/db');
    await db
      .insert(modelProviders)
      .values({ id: 'dec-9', label: 'Dec9', baseUrl: 'https://dec9.example.com', endpoints: ['TYPESAFE-SYSTEMONE'] })
      .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['TYPESAFE-SYSTEMONE'] } });
    const sec = await callProc('vault.secrets.create', { name: 'dec9-key', value: 'sk-9' });
    // harness calls the handler directly (zod only guards real transports); the
    // zod layer rejects this shape on the wire, the service layer degrades it
    await callProc('settings.update', { internalDecision: { providerId: 'dec-9', model: null, keySecretId: sec.id } });
    expect((await getSettings()).internalDecision).toBeNull();
  });

  it('garbage stored JSON parses to null (not a crash)', async () => {
    await setSetting('internal_llm', '{not json');
    expect((await getSettings()).internalLlm).toBeNull();
    await setSetting('internal_llm', JSON.stringify({ providerId: 'x' }));
    expect((await getSettings()).internalLlm).toBeNull();
    await setSetting('internal_llm', JSON.stringify({ providerId: '', keySecretId: 'k' }));
    expect((await getSettings()).internalLlm).toBeNull();
    await setSetting('internal_llm', JSON.stringify({ providerId: 'p', model: 5, keySecretId: 'k' }));
    expect((await getSettings()).internalLlm).toBeNull();
  });

  it('internalLlm saves and clears via the API', async () => {
    const { modelProviders } = await import('../server/db/schema');
    const { db } = await import('../server/db');
    await db
      .insert(modelProviders)
      .values({
        id: 'llm-2',
        label: 'Chatty2',
        baseUrl: 'https://llm2.example.com',
        endpoints: ['OPENAI-COMPLETIONS', 'OPENAI-MODELS'],
      })
      .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['OPENAI-COMPLETIONS', 'OPENAI-MODELS'] } });
    const sec = await callProc('vault.secrets.create', { name: 'llm-key2', value: 'sk-llm2' });
    await callProc('settings.update', { internalLlm: { providerId: 'llm-2', model: 'gpt-5.2', keySecretId: sec.id } });
    expect((await getSettings()).internalLlm).toEqual({ providerId: 'llm-2', model: 'gpt-5.2', keySecretId: sec.id });
    await callProc('settings.update', { internalLlm: null });
    expect((await getSettings()).internalLlm).toBeNull();
  });
});
