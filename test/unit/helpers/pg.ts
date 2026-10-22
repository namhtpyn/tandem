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

// fast per-test reset: TRUNCATE all data tables (drizzle-seed reset = TRUNCATE
// ... CASCADE), keeping task_statuses — its rows are the fixed-id seed every
// environment shares
export async function resetData() {
  const { reset } = await import('drizzle-seed');
  const { db, applyMigrations } = await import('#server/db');
  const schema = await import('#server/db/schema');
  const { taskStatuses: _keepStatuses, ...dataTables } = schema;
  try {
    await reset(db, dataTables as typeof schema);
  } catch {
    // schema not there yet (fresh container raced a file-early reset) — migrate, retry once
    await applyMigrations();
    await reset(db, dataTables as typeof schema);
  }
}

export async function resetSchema() {
  await postgres.unsafe('drop schema if exists public cascade');
  await postgres.unsafe('drop schema if exists drizzle cascade');
  await postgres.unsafe('create schema public authorization tandem');
}

