import { readdirSync, readFileSync } from 'node:fs';

import { installRqbExtensions } from './rqb-extensions';
import { env } from '../domains/kernel/env';
import { join } from 'node:path';

// Postgres client (postgres.js) + drizzle rc (Relations v2) + boot-applied migrations.
//
// Env:
//   DATABASE_URL            — postgres://user:pass@host:port/db (required in prod)
//   TANDEM_DRIZZLE_DIR      — migrations dir override (default ./drizzle)
//
// Migrations are drizzle-kit SQL folders applied at boot, tracked in the migrations table.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { user, session, account, verification, settings, relations } from './schema';

const url = env.DATABASE_URL;

// runner-side client: prepare false keeps boot-time DDL safe with pgbouncer-ish pools
export const sqlClient = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// ---------- boot migrations ----------

type MigrationSource = {
  name: string; // folder name, e.g. 20261009133348_hard_weapon_omega
  sql: string;
};

async function listMigrations() {
  // bundled nitro serverAssets: mounted at /assets, keys like "drizzle:2026...:migration.sql"
  /* v8 ignore start -- nitro-runtime branch: exercised by the real server in E2E */
  try {
    const storage = useStorage();
    const keys: string[] = await storage.getKeys('assets:drizzle:');
    const sqlKeys = keys.filter((k) => k.endsWith('.sql')).sort();
    const out: MigrationSource[] = [];
    for (const key of sqlKeys) {
      const name = key.replace(/^assets:drizzle:/, '').replace(/:migration\.sql$/, '');
      const raw = await storage.getItem(key);
      if (typeof raw === 'string') out.push({ name, sql: raw });
    }
    if (out.length > 0) return out;
  } catch (e) {
    // no nitro storage context (standalone scripts) — fall through
  }
  // 2) filesystem fallback (dev / TANDEM_DRIZZLE_DIR override)
  const drizzleDir = env.TANDEM_DRIZZLE_DIR || join(process.cwd(), 'drizzle');
  try {
    const dirs = readdirSync(drizzleDir)
      .filter((d) => /^\d+_/.test(d))
      .sort();
    return dirs.flatMap((dir) => {
      const sqlFile = readdirSync(join(drizzleDir, dir)).find((f) => f.endsWith('.sql'));
      if (!sqlFile) return [];
      return [{ name: dir, sql: readFileSync(join(drizzleDir, dir, sqlFile), 'utf8') }];
    });
  } catch {
    return [];
  }
}

export const MIGRATIONS_TABLE = 'migrations';

export async function applyMigrations() {
  const applied: string[] = [];
  // one-time ledger rename (tandem_migrations -> migrations): keep the applied
  // history so already-run migrations never re-run; fresh databases start on
  // the new name directly
  const legacy =
    await sqlClient`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'tandem_migrations'`;
  const modern =
    await sqlClient`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${MIGRATIONS_TABLE}`;
  if (legacy.length > 0 && modern.length === 0) {
    await sqlClient`alter table tandem_migrations rename to ${sqlClient(MIGRATIONS_TABLE)}`;
  }
  await sqlClient`create table if not exists ${sqlClient(MIGRATIONS_TABLE)} (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const migrations = await listMigrations();
  for (const m of migrations) {
    const already = await sqlClient`select 1 from ${sqlClient(MIGRATIONS_TABLE)} where name = ${m.name}`;
    if (already.length > 0) continue;
    const stmts = m.sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    // one transaction per migration folder
    await sqlClient.begin(async (tx) => {
      for (const stmt of stmts) await tx.unsafe(stmt);
      await tx`insert into ${sqlClient(MIGRATIONS_TABLE)} (name) values (${m.name})`;
    });
    applied.push(m.name);
  }
  return applied;
}

export const db = drizzle({ client: sqlClient, relations });

// install count/findManyAndCount on the live query builders (chunker drops bare side-effect imports)
installRqbExtensions(db.query);
