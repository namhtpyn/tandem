import { existsSync } from 'node:fs';
import path from 'node:path';

// Postgres client (Bun's native SQL) + drizzle rc (Relations v2) + boot-applied migrations.
//
// Env:
//   DATABASE_URL            — postgres://user:pass@host:port/db (required in prod)
//   TANDEM_DRIZZLE_DIR      — migrations dir override (default ./drizzle)
//   TANDEM_DB_POOL_MAX      — pool cap, 1-100 (default 10; env-contracted in kernel/env)
//
// Migrations are drizzle-kit SQL folders applied at boot by drizzle's own
// migrator (drizzle.__drizzle_migrations ledger), not a hand-rolled runner.
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

import { nonNull } from '#shared/utils/non-null';

import { env } from '../domains/kernel/env';
import { installRqbExtensions } from './rqb-extensions';
import { relations } from './schema';

const url = env.DATABASE_URL;

export const sqlClient = new SQL(url, {
  // pool cap comes from the env contract (TANDEM_DB_POOL_MAX, default 10): the test
  // suite shrinks pools so 8 workers stay under postgres's 100-connection cap, and
  // a 0/NaN bypass now fails boot validation instead of opening a dead pool
  max: env.TANDEM_DB_POOL_MAX,
  idleTimeout: 20,
  connectionTimeout: 10,
});

// ---------- boot migrations ----------

/** drizzle's folderMillis convention: millis from the 14-digit folder prefix */
export function folderMillis(name: string) {
  const parts = [0, 4, 6, 8, 10, 12].map((i) => Number(name.slice(i, i + 2)));
  if (parts.some((n) => Number.isNaN(n))) return 0; // non-timestamp folder names
  return Date.UTC(
    2000 + nonNull(parts[0]),
    nonNull(parts[1]) - 1,
    nonNull(parts[2]),
    nonNull(parts[3]),
    nonNull(parts[4]),
    nonNull(parts[5]),
  );
}

async function appliedNames(): Promise<string[]> {
  const t = await sqlClient`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!t[0]?.t) return [];
  const rows = await sqlClient`select name from drizzle.__drizzle_migrations where name is not null`;
  return rows.map((r: { name: string }) => r.name);
}

/** apply pending drizzle migrations; returns the folders applied this boot */
export async function applyMigrations() {
  const migrationsFolder = env.TANDEM_DRIZZLE_DIR || path.join(process.cwd(), 'drizzle');
  if (!existsSync(migrationsFolder)) return [];
  const before = new Set(await appliedNames());
  await migrate(db, { migrationsFolder });
  return (await appliedNames()).filter((n) => !before.has(n));
}

export const db = drizzle({ client: sqlClient, relations });

// install count/findManyAndCount on the live query builders (chunker drops bare side-effect imports)
installRqbExtensions(db.query);

/** an open transaction from db.transaction — the tx shares the pool db's query-builder surface */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** service fns accept either the pool db or an open tx so their writes join the caller's transaction */
export type DbExecutor = typeof db | DbTx;

/** view an executor through the db surface — tx and db expose the same query builders */
export const asDb = (ex: DbExecutor): typeof db => ex as typeof db;
