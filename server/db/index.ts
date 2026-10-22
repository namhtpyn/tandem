import { existsSync } from 'node:fs';
import path from 'node:path';

// Postgres client (Bun's native SQL) + drizzle rc (Relations v2) + boot-applied migrations.
//
// Env:
//   DATABASE_URL            — postgres://user:pass@host:port/db (required in prod)
//   TANDEM_DRIZZLE_DIR      — migrations dir override (default ./drizzle)
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
  // TANDEM_DB_POOL_MAX: the test suite runs one DB per worker and shrinks
  // pools so 8 workers stay under postgres's 100-connection cap
  max: Number(process.env.TANDEM_DB_POOL_MAX ?? 10),
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
