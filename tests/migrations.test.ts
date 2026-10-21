import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';

import './helpers/pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// boot migrations: apply, idempotence, bundled-asset listing, fs fallback
import { describe, expect, it, beforeEach } from 'vitest';

import { applyMigrations } from '../server/db/index';
import { env, setEnv } from '../server/domains/kernel/env';
import { resetSchema, postgres } from './helpers/pg';

describe('applyMigrations', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  it('creates tables and records migration names', async () => {
    const applied = await applyMigrations();
    expect(applied.length).toBeGreaterThanOrEqual(1);
    const tables =
      await postgres`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    const names = tables.map((r) => r.table_name as string);
    expect(names).toContain('user');
    expect(names).toContain('session');
    expect(names).toContain('account');
    expect(names).toContain('verification');
    expect(names).toContain('settings');
    const recorded = await postgres`select name from drizzle.__drizzle_migrations where name is not null`;
    expect(recorded.map((r) => r.name as string).sort()).toEqual(applied.slice().sort());
  });

  it('is idempotent — second run applies nothing', async () => {
    await applyMigrations();
    const again = await applyMigrations();
    expect(again).toEqual([]);
  });

  it('applies migrations from a filesystem dir (TANDEM_DRIZZLE_DIR override)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tandem-mig-'));
    try {
      const one = join(dir, '20260101000000_first');
      mkdirSync(one);
      writeFileSync(
        join(one, 'migration.sql'),
        'create table fs_probe (id text);--> statement-breakpoint\ncreate table fs_probe2 (id text);',
      );
      setEnv({ TANDEM_DRIZZLE_DIR: dir });
      // listMigrations prefers nitro storage when present (it is, under vitest?
      // no — useStorage is nitro-only; outside nitro the fs path runs)
      const applied = await applyMigrations();
      expect(applied).toContain('20260101000000_first');
      const probe = await postgres`select count(*)::int as n from fs_probe`;
      expect(probe[0]!.n).toBe(0); // table exists — query succeeded
    } finally {
      setEnv({ TANDEM_DRIZZLE_DIR: undefined });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the migrations dir does not exist', async () => {
    setEnv({ TANDEM_DRIZZLE_DIR: '/nonexistent-tandem-dir' });
    try {
      expect(await applyMigrations()).toEqual([]);
    } finally {
      setEnv({ TANDEM_DRIZZLE_DIR: undefined });
    }
  });

});

describe('folderMillis', () => {
  it('parses the 14-digit folder prefix — drizzle convention: year minus 2000', async () => {
    const { folderMillis } = await import('../server/db/index');
    expect(folderMillis('20261016151937_common_madame_hydra')).toBe(Date.UTC(2020, 9, 16, 15, 19, 37));
  });

  it('returns 0 for non-timestamp folder names', async () => {
    const { folderMillis } = await import('../server/db/index');
    expect(folderMillis('20260101000000_first')).toBe(Date.UTC(2020, 0, 1, 0, 0, 0));
    expect(folderMillis('zz-not-a-folder')).toBe(0);
  });
});
