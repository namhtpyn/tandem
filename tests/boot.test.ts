// boot plugin: migrations + admin seed + already-seeded skip + hash failure path
import { describe, expect, it, beforeEach, vi } from 'vitest';

import './api-harness';
import { sqlClient } from '../server/db/index';
import { env, setEnv } from '../server/domains/kernel/env';
import { ROLE } from '../shared/enums';
import { resetSchema } from './helpers/pg';

const bootModule = () => import('../server/plugins/boot');

beforeEach(async () => {
  await resetSchema();
  const { applyMigrations } = await import('../server/db/index');
  await applyMigrations();
});

describe('boot plugin', () => {
  it('seeds the admin when no users exist', async () => {
    const mod = await bootModule();
    const plugin = mod.default as () => Promise<unknown>;
    await plugin();
    const users = await sqlClient`select email, role from "user"`;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'admin@tandem.local', role: ROLE.ADMIN });
    const accounts = await sqlClient`select provider_id, password from account`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.password).toMatch(/^[0-9a-f]{32}:/);
  });

  it('seeds with ADMIN_EMAIL/ADMIN_PASSWORD overrides', async () => {
    setEnv({ ADMIN_EMAIL: 'root@corp.example' });
    setEnv({ ADMIN_PASSWORD: 'sup3r-secret' });
    try {
      const mod = await bootModule();
      await (mod.default as () => Promise<unknown>)();
      const users = await sqlClient`select email from "user"`;
      expect(users[0]!.email).toBe('root@corp.example');
      const { verifyPassword } = await import('better-auth/crypto');
      const acct = (await sqlClient`select password from account`)[0]!;
      expect(await verifyPassword({ hash: acct.password, password: 'sup3r-secret' })).toBe(true);
    } finally {
      setEnv({ ADMIN_EMAIL: undefined });
      setEnv({ ADMIN_PASSWORD: undefined });
    }
  });

  it('skips seeding when users already exist', async () => {
    await sqlClient`insert into "user" (id, name, email, email_verified, created_at, updated_at, role)
      values ('00000000-0000-7000-8000-c188c39acb1b', 'Existing', 'e@x.co', true, now(), now(), ROLE.VIEWER)`;
    const mod = await bootModule();
    await (mod.default as () => Promise<unknown>)();
    const users = await sqlClient`select count(*)::int as n from "user"`;
    expect(users[0]!.n).toBe(1);
    const accounts = await sqlClient`select count(*)::int as n from account`;
    expect(accounts[0]!.n).toBe(0);
  });
});
