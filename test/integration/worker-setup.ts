// Per-worker database, cloned from the migrated template. Each vitest worker
// gets its OWN database (CREATE DATABASE ... TEMPLATE — a physical clone, ~100ms
// vs seconds), so files run in parallel without seeing each other's rows.
// resetData() (helpers/pg.ts) truncates between tests — one TRUNCATE per test.
import { SQL } from 'bun';

const base = process.env.TANDEM_TEST_DATABASE_URL;
/** resolved once here — test-client reads this instead of process.env (env law) */
export const templateDatabaseUrl = base;
(globalThis as { __tandemTestUrl?: string }).__tandemTestUrl = base;
if (!base) throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not run');

// The template is whatever TANDEM_TEST_DATABASE_URL points at: parse the db
// name out of the URL instead of hardcoding it — global-setup (local
// container) and CI (service container) each choose their own.
const baseDb = new URL(base);
const templateDb = decodeURIComponent(baseDb.pathname.replace(/\/+$/, '').split('/').pop() ?? '');
if (!templateDb) throw new Error('TANDEM_TEST_DATABASE_URL carries no database name');

const workerId = process.env.VITEST_POOL_ID ?? '1';
// Host-pid tail: two vitest HOSTS (e.g. two worktrees) against one shared
// postgres both clone the same template — identical `…_w1` names would let one
// host's setup drop the other's database mid-run. Postgres identifiers cap at
// 63 bytes, so the tail (the uniqueness-critical part) must survive truncation.
// The run-id tail is stamped by global-setup so teardown can drop exactly this
// run's clones (crashed runs are swept at the NEXT startup).
const runId = process.env.TANDEM_TEST_RUN_ID ?? 'adhoc';
const dbName = `${templateDb}_w${workerId}_h${process.pid}_r${runId}`.slice(-63);

const withDbName = (db: string) => {
  const url = new URL(base);
  url.pathname = `/${encodeURIComponent(db)}`;
  return url.toString();
};
const workerUrl = withDbName(dbName);

// quote as a PG identifier (identifiers can carry anything but a bare `"`)
const pgIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

// connect to the maintenance DB: terminate races between workers kill
// connections that sit on the template itself
const admin = new SQL(withDbName('postgres'), { max: 1 });
await admin.unsafe(`drop database if exists ${pgIdent(dbName)} with (force)`);
// a physical clone beats dump/restore (~100ms vs seconds). Nothing reconnects
// to the template after global-setup migrates, but lingering pool sockets hold
// the template lock — terminate them, then clone. Parametrized: the template
// name is data here, not a hardcoded literal.
await admin.unsafe(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
  [templateDb],
);
await admin.unsafe(`create database ${pgIdent(dbName)} template ${pgIdent(templateDb)}`);
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

  // setupFiles run once per FILE, and vitest's forks pool REUSES processes for
  // several files: a previous file's BullMQ workers keep their (unclosed) redis
  // sockets alive — a zombie worker on the same per-agent queue name steals the
  // next file's dispatch jobs (CI-red dispatcher suite, runs #40). Namespace
  // queue names per file execution AND flush the db index for a clean slate.
  const g = globalThis as { __tandemFileSeq?: number };
  g.__tandemFileSeq = (g.__tandemFileSeq ?? 0) + 1;
  process.env.TANDEM_QUEUE_NS = `${process.pid}f${g.__tandemFileSeq}${runId}`;
  const { createClient } = await import('redis');
  const sweep = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: () => new Error('no-retry') },
  });
  try {
    await sweep.connect();
    await sweep.flushDb();
  } finally {
    sweep.disconnect();
  }
}
