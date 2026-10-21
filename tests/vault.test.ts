import { eq } from 'drizzle-orm';
// Vault domain tests — real Postgres, driven through the oRPC handler edge
// (same pattern as employees.test.ts). Plaintext round-trip is tested at the
// vault-crypto module level; here we assert the API NEVER exposes it.
import { beforeEach, describe, expect, it } from 'vitest';

import './api-harness';
import { applyMigrations } from '../server/db/index';
import { decryptSecret, encryptSecret, lastFourHint } from '../server/domains/vault/secret/secret-crypto.service';
import type { VaultSecretRow } from '../shared/types';
import { resetSchema } from './helpers/pg';
import { ROLE } from '../shared/enums';
import { env, setEnv } from '../server/domains/kernel/env';

const admin = { id: '00000000-0000-7000-8000-c5ea71554c77', name: 'A', email: 'a@x', role: ROLE.ADMIN };

async function ctx(sessionUser: { id: string; name: string; email: string; role: string } | null = admin) {
  const { buildServerContext } = await import('../server/domains/kernel/context');
  const context = buildServerContext(new Headers());
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () =>
    sessionUser ? { user: sessionUser } : null;
  return context;
}

async function callProc(
  path: string,
  input?: unknown,
  sessionUser: { id: string; name: string; email: string; role: string } | null = admin,
): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router');
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>;
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> };
  return await internals.handler({
    input,
    context: { ...(await ctx()), session: { user: sessionUser ?? admin } },
    signal: new AbortController().signal,
  });
}

async function dbm() {
  return await import('../server/db');
}

async function schema() {
  return await import('../server/db/schema');
}

/** factory: a user row (vault secrets FK-require one) */
async function userFactory(id: string) {
  const { db } = await dbm();
  const { user } = await schema();
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@tandem.local`,
    emailVerified: true,
    role: ROLE.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/** factory: a persisted secret via the API; returns the API row */
async function secretFactory(name: string, value = 'super-secret-value', description = '') {
  return await callProc('vault.secrets.create', { name, value, description });
}

beforeEach(async () => {
  await resetSchema();
  await applyMigrations();
  await userFactory('00000000-0000-7000-8000-c5ea71554c77');
});

describe('vault-crypto (module)', () => {
  it('round-trips AES-256-GCM envelopes', () => {
    const env = encryptSecret('hunter2');
    expect(env.startsWith('v1:')).toBe(true);
    expect(decryptSecret(env)).toBe('hunter2');
  });

  it('uses a fresh IV per encryption (ciphertexts differ)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects malformed envelopes', () => {
    expect(() => decryptSecret('v2:a:b:c')).toThrow('malformed vault envelope');
    expect(() => decryptSecret('garbage')).toThrow('malformed vault envelope');
  });

  it('fails on tampered ciphertext (GCM auth)', () => {
    const env = encryptSecret('hunter2');
    const parts = env.split(':');
    const ct = Buffer.from(parts[3]!, 'base64');
    ct[0]! ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('rejects wrong-size TANDEM_VAULT_KEY; generateVaultKeyB64 gives 32 bytes', async () => {
    const mod = await import('../server/domains/vault/secret/secret-crypto.service');
    setEnv({ TANDEM_VAULT_KEY: Buffer.alloc(16).toString('base64') });
    mod.resetVaultKeyCache();
    expect(() => mod.getVaultKey()).toThrowError(/32 bytes/);
    const fresh = mod.generateVaultKeyB64();
    expect(Buffer.from(fresh, 'base64')).toHaveLength(32);
    setEnv({ TANDEM_VAULT_KEY: fresh });
    mod.resetVaultKeyCache();
    expect(mod.getVaultKey()).toHaveLength(32);
    // REQUIRED: no env -> hard throw, never a fallback key
    setEnv({ TANDEM_VAULT_KEY: undefined });
    mod.resetVaultKeyCache();
    expect(() => mod.getVaultKey()).toThrowError(/TANDEM_VAULT_KEY is required/);
    setEnv({ TANDEM_VAULT_KEY: fresh });
    mod.resetVaultKeyCache();
  });

  it('lastFourHint never reveals short values', () => {
    expect(lastFourHint('ab')).toBe('••••');
    expect(lastFourHint('abcd')).toBe('••••');
    expect(lastFourHint('abcde')).toBe('bcde');
  });
});

describe('vault API', () => {
  it('live lists metadata only — no ciphertext, no plaintext', async () => {
    await secretFactory('ssh-prod-key', 'AKIAIO...MPLE');
    const iter = await callProc('vault.secrets.live');
    const snap = await iter.next();
    const rows = (snap.value as { data: VaultSecretRow[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('ssh-prod-key');
    expect(rows[0]!.lastFour).toBe('MPLE');
    expect(JSON.stringify(rows)).not.toContain('AKIA');
    expect(JSON.stringify(rows)).not.toContain('ciphertext');
    await iter.return?.();
  });

  it('list paginates server-side via findManyAndCount (page, pageSize, folderId)', async () => {
    const folder = await callProc('vault.folders.save', { name: 'Paged' }) as { id: string };
    for (let i = 0; i < 3; i++) {
      await callProc('vault.secrets.create', {
        name: `paged-${i}`,
        value: `v-${i}`,
        description: '',
        folderId: i < 2 ? folder.id : null,
      });
    }
    const page1 = await callProc('vault.secrets.list', { page: 1, pageSize: 2 }) as {
      data: VaultSecretRow[];
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.data).toHaveLength(2);
    const page2 = await callProc('vault.secrets.list', { page: 2, pageSize: 2 }) as {
      data: VaultSecretRow[];
      total: number;
    };
    expect(page2.data).toHaveLength(1);
    // folder filter narrows both data and total
    const filtered = await callProc('vault.secrets.list', { page: 1, pageSize: 20, folderId: folder.id }) as {
      data: VaultSecretRow[];
      total: number;
    };
    expect(filtered.total).toBe(2);
    expect(filtered.data.every((r) => r.folder === 'Paged')).toBe(true);
  });

  it('list searches server-side (q matches name or description, ilike)', async () => {
    await callProc('vault.secrets.create', { name: 'github-pat-prod', value: 'v1', description: 'deploy key' });
    await callProc('vault.secrets.create', { name: 'unrelated-row', value: 'v2', description: 'nothing here' });
    const byName = await callProc('vault.secrets.list', { page: 1, pageSize: 20, q: 'github' }) as {
      data: VaultSecretRow[];
      total: number;
    };
    expect(byName.total).toBe(1);
    expect(byName.data[0]!.name).toBe('github-pat-prod');
    const byDesc = await callProc('vault.secrets.list', { page: 1, pageSize: 20, q: 'DEPLOY' }) as {
      data: VaultSecretRow[];
      total: number;
    };
    expect(byDesc.total).toBe(1);
    const none = await callProc('vault.secrets.list', { page: 1, pageSize: 20, q: 'zzz-no-match' }) as {
      total: number;
    };
    expect(none.total).toBe(0);
  });

  it('create stores an encrypted envelope the API cannot read back', async () => {
    const row = await secretFactory('db-password', 'correct-horse-battery');
    expect(row.lastFour).toBe('tery');
    // DB row must contain a GCM envelope, not the plaintext
    const { db } = await dbm();
    const { vaultSecrets } = await schema();
    const raw = await db.select().from(vaultSecrets);
    expect(raw[0]!.ciphertext.startsWith('v1:')).toBe(true);
    expect(raw[0]!.ciphertext).not.toContain('correct-horse');
    // server-side decrypt still works (M5 runner path)
    expect(decryptSecret(raw[0]!.ciphertext)).toBe('correct-horse-battery');
  });

  it('allows duplicate names (non-unique by design)', async () => {
    const a = await callProc('vault.secrets.create', { name: 'dup', value: 'x', description: 'first' });
    const b = await callProc('vault.secrets.create', { name: 'dup', value: 'y', description: 'second' });
    expect(a.id).not.toBe(b.id);
    expect(a.description).toBe('first');
    expect(b.description).toBe('second');
  });

  it('update replaces the value and rotates the envelope', async () => {
    const { db } = await dbm();
    const { vaultSecrets } = await schema();
    const created = await secretFactory('rotate-me', 'old-value-123');
    await callProc('vault.secrets.update', {
      id: created.id,
      name: 'rotate-me',
      description: 'rotated note',
      value: 'new-value-456',
    });
    const raw = await db.select().from(vaultSecrets);
    expect(decryptSecret(raw[0]!.ciphertext)).toBe('new-value-456');
    expect(raw[0]!.lastFour).toBe('-456');
    expect(raw[0]!.ciphertext).not.toBe((await db.select().from(vaultSecrets)).toString());
  });

  it('update persists description; missing id 404s', async () => {
    const secret = await secretFactory('desc-test');
    const updated = await callProc('vault.secrets.update', {
      id: secret.id,
      name: 'desc-test',
      description: 'new note',
      value: 'v2',
    });
    expect(updated.description).toBe('new note');
    await expect(
      callProc('vault.secrets.update', { id: 'missing', name: 'x', description: '', value: 'v' }),
    ).rejects.toThrowError(/not found/);
  });

  it('remove of a missing secret 404s', async () => {
    await expect(callProc('vault.secrets.remove', { id: 'nope' })).rejects.toThrowError(/not found/);
  });

  it('unauthenticated calls are rejected', async () => {
    const { appRouter: router } = await import('../server/domains/app.router');
    let cur: Record<string, unknown> = router as unknown as Record<string, unknown>;
    for (const k of ['vault', 'secrets', 'create']) cur = cur[k] as Record<string, unknown>;
    const node = cur['~orpc'] as { handler: (o: unknown) => Promise<unknown> };
    const context = buildAnonContext();
    const res = (await node
      .handler({ input: { name: 'x', value: 'y', description: '' }, context, signal: new AbortController().signal })
      .catch((e) => e)) as { message?: string };
    expect(String(res?.message ?? res)).toMatch(/authentication required|Cannot read|session/);
  });
});

async function buildAnonContext() {
  const { buildServerContext } = await import('../server/domains/kernel/context');
  const context = buildServerContext(new Headers());
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null;
  return context;
}
