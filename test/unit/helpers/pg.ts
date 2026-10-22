// Shared vitest helper: a REAL Postgres (TestContainers container from
// global-setup, fresh per suite run). All test files use the SAME database —
// resetSchema() drops public+drizzle per test, so each test starts clean.
// Order-independent: DATABASE_URL comes from setup.ts (already pointed at the
// container), so no import-order coupling — any module that imports
// '#server/db/index' sees the same database.
import { SQL } from 'bun';

export const TEST_DATABASE_URL =
  process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:5432/tandem_test';

export const postgres = new SQL(TEST_DATABASE_URL, {
  max: 5,
  idleTimeout: 5,
  connectionTimeout: 10,
});

// The fixed-id status seed: captured ONCE from the migrated database (the
// same rows a fresh environment gets) and replayed after every truncate.
// Columns are filtered against the live table so later migrations that add
// columns cannot break the replay.
let statusSeed: Record<string, unknown>[] | null = null;

/** Snapshot the status seed — must run while the rows still exist. */
export async function captureStatusSeed() {
  if (statusSeed && statusSeed.length > 0) return;
  // to_json gives next_ids as a real JSON array in every runtime — Bun SQL's
  // raw text[] decoding is inconsistent between plain bun and vitest workers
  const rows = await postgres`select id, name, color, position, category, created_at, updated_at, to_json(next_ids) as next_ids_json from task_statuses`;
  statusSeed = rows.map(({ next_ids_json, ...rest }) => ({ ...rest, next_ids: next_ids_json }));
}

async function reseedStatuses() {
  await captureStatusSeed();
  const rows = statusSeed ?? [];
  if (rows.length === 0) throw new Error('status seed missing: capture ran against an empty table');
  // Bun SQL mangles array params (sends "a,b" where text[] is expected), so
  // values are inlined as literals — the seed is fixed fixture data, not input
  const lit = (v: unknown): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `'{${v.map((x) => `"${String(x).replaceAll('"', '\\"')}"`).join(',')}}'`;
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (typeof v === 'object') return `'${JSON.stringify(v).replaceAll("'", "''")}'`;
    return `'${String(v).replaceAll("'", "''")}'`;
  };
  for (const row of rows) {
    const cols = Object.keys(row);
    const values = cols.map((c) => lit(row[c])).join(', ');
    await postgres.unsafe(
      `insert into task_statuses (${cols.map((c) => `"${c}"`).join(', ')}) values (${values})`,
    );
  }
}

// per-test reset: TRUNCATE every table (drizzle-seed reset = TRUNCATE
// ... CASCADE), then replay the status seed. Schema + migrations exist before
// any worker — they are applied once in global-setup, so a truncate never
// meets missing tables.
let sp = 0;

export async function resetData() {
  // worker holds one transaction for its whole life (worker-setup.ts): rolling
  // back to a fresh savepoint is the reset — ~1ms, and it also undoes whatever
  // the previous test committed through any connection
  const tx = await postgres`select current_setting('tandem.test_tx', true) as v`;
  if (tx[0]?.v === '1') {
    if (sp > 0) await postgres.unsafe(`rollback to savepoint s${sp}`);
    sp += 1;
    await postgres.unsafe(`savepoint s${sp}`);
    await reseedStatuses();
    return;
  }
  await captureStatusSeed(); // pre-truncate: the only moment the rows exist
  const { reset } = await import('drizzle-seed');
  const { db, applyMigrations } = await import('#server/db');
  const schema = await import('#server/db/schema');
  try {
    await reset(db, schema);
  } catch {
    // migration-subject tests drop the schema mid-file — rebuild, then reset
    await applyMigrations();
    await reset(db, schema);
  }
  await reseedStatuses();
}

export async function resetSchema() {
  await postgres.unsafe('drop schema if exists public cascade');
  await postgres.unsafe('drop schema if exists drizzle cascade');
  await postgres.unsafe('create schema public authorization tandem');
}


// File-boundary invariant: migrations are applied and the ledger agrees with
// the journal. Migration-subject tests (migrations/boot/fresh-ledger arms)
// deliberately corrupt this state; drizzle's migrator no-ops when the ledger
// is complete and we drop+rebuild when it disagrees with existing tables.
export async function ensureMigrated() {
  const { applyMigrations } = await import('#server/db');
  try {
    await applyMigrations();
  } catch {
    await resetSchema();
    await applyMigrations();
  }
}

/** Pin the app's pooled connections into this worker's transaction. The app
 * code under test opens its own pool (server/db) — without this, its writes
 * commit for real and leak across tests. Called once per worker. */
export async function joinWorkerTransaction() {
  const { sqlClient } = await import('#server/db');
  await sqlClient`select set_config('tandem.test_tx', '1', false)`;
}
