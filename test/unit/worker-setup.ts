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

// connect to the maintenance DB: terminate races between workers kill
// connections that sit on the template itself
const admin = new SQL(base.replace(/\/[^/]*$/, '/postgres'), { max: 1 });
await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
// a physical clone beats dump/restore (~100ms vs seconds). Nothing reconnects
// to the template after global-setup migrates, but lingering pool sockets hold
// the template lock — terminate them, then clone
await admin.unsafe(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = 'tandem_test' and pid <> pg_backend_pid()`,
);
await admin.unsafe(`create database "${dbName}" template tandem_test`);
await admin.close();

process.env.DATABASE_URL = workerUrl;
process.env.TANDEM_TEST_DATABASE_URL = workerUrl;
process.env.TANDEM_DB_POOL_MAX = '3';
// one DB per worker, up to 8 workers: the prod pool of 10 overflows postgres's
// 100-connection cap. Read by server/db at construction (post-construct max is ignored).

// redis pub/sub is shared per server — a worker's bus would count every other
// worker's publishes. Put each worker on its own redis DB index (0-14)
if (process.env.REDIS_URL) {
  const idx = (Number(workerId) || 0) % 15;
  const base = process.env.REDIS_URL.replace(/\/\d*$/, ''); // strip an existing /db too
  process.env.REDIS_URL = `${base}/${idx}`;
  console.log(`[worker-setup] pool=${workerId} redis=${process.env.REDIS_URL}`);
}

// the transaction every connection of this worker joins
const holder = new SQL(workerUrl, { max: 1 });
await holder`begin`;
await holder`select set_config('tandem.test_tx', '1', false)`;

// app code's pooled connections must join the same transaction

const { joinWorkerTransaction } = await import('./helpers/pg');
await joinWorkerTransaction();