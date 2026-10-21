import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Postgres client (postgres.js) + drizzle rc (Relations v2) + boot-applied migrations.
//
// Env:
//   DATABASE_URL            — postgres://user:pass@host:port/db (required in prod)
//   TANDEM_DRIZZLE_DIR      — migrations dir override (default ./drizzle)
//
// Migrations are drizzle-kit SQL folders applied at boot by drizzle's own
// migrator (drizzle.__drizzle_migrations ledger), not a hand-rolled runner.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { env } from '../domains/kernel/env';
import { installRqbExtensions } from './rqb-extensions';
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

/** drizzle's folderMillis convention: millis from the 14-digit folder prefix */
function folderMillis(name: string): number {
  const parts = [0, 4, 6, 8, 10, 12].map((i) => Number(name.slice(i, i + 2)));
  if (parts.some((n) => Number.isNaN(n))) return 0; // non-timestamp folder names
  return Date.UTC(2000 + parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!);
}

async function appliedNames(): Promise<string[]> {
  const t = await sqlClient`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!t[0]?.t) return [];
  const rows = await sqlClient`select name from drizzle.__drizzle_migrations where name is not null`;
  return rows.map((r) => r.name as string);
}

/** earlier custom runner tracked by folder name in public.tandem_migrations / public.migrations —
 * adopt those rows into drizzle's ledger so already-run folders never re-run */
async function adoptLegacyLedger(migrationsFolder: string) {
  const old = await sqlClient`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'tandem_migrations'`;
  const cur = await sqlClient`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'migrations'`;
  if (old.length > 0 && cur.length === 0) await sqlClient`alter table tandem_migrations rename to migrations`;
  const legacy = await sqlClient`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'migrations'`;
  if (legacy.length === 0) return;
  const rows = await sqlClient`select name from migrations`;
  if (rows.length === 0 || (await appliedNames()).length > 0) return;
  await sqlClient`create schema if not exists drizzle`;
  await sqlClient`create table if not exists drizzle.__drizzle_migrations (
    id serial primary key,
    hash text not null,
    created_at bigint,
    name text,
    applied_at timestamptz default now()
  )`;
  for (const { name } of rows) {
    const file = join(migrationsFolder, name as string, 'migration.sql');
    if (!existsSync(file)) continue;
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    await sqlClient`insert into drizzle.__drizzle_migrations (hash, created_at, name) values (${hash}, ${folderMillis(name as string)}, ${name as string})`;
  }
}

/** apply pending drizzle migrations; returns the folders applied this boot */
export async function applyMigrations(): Promise<string[]> {
  const migrationsFolder = env.TANDEM_DRIZZLE_DIR || join(process.cwd(), 'drizzle');
  if (!existsSync(migrationsFolder)) return [];
  await adoptLegacyLedger(migrationsFolder);
  const before = new Set(await appliedNames());
  await migrate(db, { migrationsFolder });
  return (await appliedNames()).filter((n) => !before.has(n));
}

export const db = drizzle({ client: sqlClient, relations });

// install count/findManyAndCount on the live query builders (chunker drops bare side-effect imports)
installRqbExtensions(db.query);
