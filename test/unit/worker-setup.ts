// Per-worker database + one held transaction. Each vitest worker gets its OWN
// database (cloned from the migrated template), so files run in parallel
// without seeing each other's rows. The worker then opens a single transaction
// and pins it with a session var: every later connection (app code included)
// joins it, and resetData rolls back to a savepoint instead of truncating.
import { SQL } from 'bun';

const base = process.env.TANDEM_TEST_DATABASE_URL;
if (!base) throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not run');

const workerId = process.env.VITEST_POOL_ID ?? '1';
const dbName = `tandem_w${workerId}`;
const workerUrl = base.replace(/\/[^/]*$/, `/${dbName}`);

// dump/restore instead of CREATE DATABASE ... TEMPLATE: the template is locked
// while any connection to it exists, and global-setup's migrate connection does
const { execSync } = await import('node:child_process');
const admin = new SQL(base, { max: 1 });
await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
await admin.unsafe(`create database "${dbName}"`);
await admin.close();
const pgUrl = (db: string) => base.replace(/\/[^/]*$/, `/${db}`);
execSync(
  `pg_dump --no-owner --no-privileges "${pgUrl('tandem_test')}" | psql -q "${pgUrl(dbName)}"`,
  { stdio: 'ignore' },
);

process.env.DATABASE_URL = workerUrl;
process.env.TANDEM_TEST_DATABASE_URL = workerUrl;
process.env.TANDEM_DB_POOL_MAX = '3';
// one DB per worker, up to 8 workers: the prod pool of 10 overflows postgres's
// 100-connection cap. Read by server/db at construction (post-construct max is ignored).

// the transaction every connection of this worker joins
const holder = new SQL(workerUrl, { max: 1 });
await holder`begin`;
await holder`select set_config('tandem.test_tx', '1', false)`;

// app code's pooled connections must join the same transaction

const { joinWorkerTransaction } = await import('./helpers/pg');
await joinWorkerTransaction();
