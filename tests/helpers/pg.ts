// Shared vitest helper: a REAL Postgres (Docker tandem-pg). Each test FILE gets
// its OWN DATABASE — created on import, dropped on afterAll — so parallel files
// never collide and the app's pooled client needs zero search_path hacks.
// App modules are imported lazily (in beforeAll) AFTER DATABASE_URL is pointed
// at this file's database, because server/db/index.ts reads DATABASE_URL at
// module scope.
import { SQL } from 'bun';
import { afterAll, beforeAll } from 'vitest';

const ROOT_URL = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test';
const u = new URL(ROOT_URL);
const DB_NAME = `t_${Math.random().toString(36).slice(2, 10)}`;
export const TEST_DATABASE_URL = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port}/${DB_NAME}`;

// admin client on the server (connect to the root/test database)
const admin = new SQL(ROOT_URL, { max: 1 });

// our raw client into the fresh database
export const postgres = new SQL(TEST_DATABASE_URL, {
  max: 5,
  idleTimeout: 5,
  connectionTimeout: 10,
});

export async function resetSchema() {
  await postgres.unsafe('drop schema if exists public cascade');
  await postgres.unsafe('drop schema if exists drizzle cascade');
  await postgres.unsafe('create schema public authorization tandem');
}

// Top-level: create the per-file database and point DATABASE_URL at it BEFORE
// any app module body executes (import order in test files puts this helper
// before '../server/db/index').
await admin.unsafe(`create database ${DB_NAME} owner tandem`);
process.env.DATABASE_URL = TEST_DATABASE_URL;
const { applyMigrations, sqlClient } = await import('../../server/db/index');
await applyMigrations();

afterAll(async () => {
  try {
    await postgres.close();
    await sqlClient.end();
  } catch {
    /* pool may already be gone */
  }
  // Concurrent `drop database with (force)` from parallel test files serialize
  // behind checkpoints (CheckpointDone waits) and blow the hook timeout; a
  // crashed worker can also leak a held advisory lock forever. So: no shared
  // lock — just cap THIS drop statement. On timeout the DB is orphaned and the
  // global-setup sweep (name prefix t\_) removes it next run.
  try {
    await admin.unsafe('set statement_timeout = 8000');
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
  } catch {
    /* best effort — sweep catches it */
  }
  try {
    await admin.close();
  } catch {
    /* best effort */
  }
});
