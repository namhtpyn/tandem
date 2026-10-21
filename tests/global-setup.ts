import { execSync } from 'node:child_process';

// Suite-scoped test Postgres. Runs ONCE in the main vitest process (not per
// worker): starts/reuses a dedicated container, hands every worker its URL via
// `provide`, and tears it down when the WHOLE suite finishes.
// CI: a postgres service container already exists (TANDEM_TEST_DATABASE_URL),
// so this is a pass-through. The dev container (tandem-pg) is never touched.
import type { GlobalSetupContext } from 'vitest/node';

const NAME = 'tandem-test-pg';
const REDIS_NAME = 'tandem-test-redis';
const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = '6399';
const needsLocalContainer = !process.env.TANDEM_TEST_DATABASE_URL && !process.env.CI;

function run(cmd: string) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function containerRunning() {
  try {
    return run(`docker inspect -f {{.State.Running}} ${NAME}`) === 'true';
  } catch {
    return false;
  }
}

async function waitForReadiness() {
  // pg_isready rc=0 during init even though logins are rejected — probe a
  // real authenticated query through the mapped port instead.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      run(`docker exec ${NAME} psql -U tandem -d tandem_test -c 'select 1'`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('tandem-test-pg did not accept logins in 30s');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function discoverPort() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const port = run(`docker port ${NAME} 5432/tcp`).split('\n')[0]!.split(':').pop()!.trim();
      if (port) return port;
    } catch {
      /* container still creating */
    }
    if (Date.now() > deadline) throw new Error('tandem-test-pg never exposed a port');
    await new Promise((r) => setTimeout(r, 250));
  }
}

function redisRunning() {
  try {
    return run(`docker inspect -f {{.State.Running}} ${REDIS_NAME}`) === 'true';
  } catch {
    return false;
  }
}

/** redis is a hard dependency — every suite run (dev or CI) gets a URL */
async function ensureRedis({ provide }: GlobalSetupContext) {
  if (process.env.CI) {
    // the workflow's redis service is already up and REDIS_URL is in the job env
    provide('redisUrl', process.env.REDIS_URL!);
    return;
  }
  if (!redisRunning()) {
    try {
      run(`docker rm -f ${REDIS_NAME}`);
    } catch {
      /* none */
    }
    run(`docker run -d --rm --name ${REDIS_NAME} -p ${REDIS_PORT}:6379 ${REDIS_IMAGE}`);
  }
  process.env.REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
  provide('redisUrl', process.env.REDIS_URL);
}

export async function setup(ctx: GlobalSetupContext) {
  await ensureRedis(ctx);
  const { provide } = ctx;
  if (!needsLocalContainer) {
    const url = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:5432/tandem_test';
    process.env.TANDEM_TEST_DATABASE_URL = url;
    // Sweep orphaned per-file test databases from a previous crashed run
    // (drop-timeout leftovers). Best effort — never blocks the run.
    try {
      const url = new URL(
        process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test',
      );
      const admin = new Bun.SQL(url.href, { max: 1 });
      const rows = await admin.unsafe<{ datname: string }>(
        "select datname from pg_database where datname like 't\\_%' escape '\\' and pg_get_userbyid(datdba) = current_user",
      );
      for (const r of rows) {
        await admin.unsafe(`drop database if exists "${r.datname}" with (force)`);
      }
      await admin.close();
    } catch {
      /* best effort */
    }

    provide('testDatabaseUrl', url);
    return;
  }

  // Reuse a healthy leftover from a crashed run; otherwise (re)create.
  if (!containerRunning()) {
    try {
      run(`docker rm -f ${NAME}`);
    } catch {
      /* none */
    }
    const port = String(39000 + Math.floor(Math.random() * 1000));
    run(
      `docker run -d --rm --name ${NAME} -e POSTGRES_USER=tandem -e POSTGRES_PASSWORD=tandem -e POSTGRES_DB=tandem_test -p ${port}:5432 postgres:18-alpine`,
    );
  }
  await waitForReadiness();
  const port = await discoverPort();
  const url = `postgresql://tandem:tandem@127.0.0.1:${port}/tandem_test`;
  process.env.TANDEM_TEST_DATABASE_URL = url;
  provide('testDatabaseUrl', url);
}

export async function teardown() {
  if (!needsLocalContainer) return;
  try {
    run(`docker rm -f ${NAME}`);
  } catch {
    /* already gone */
  }
  // redis container is left running: create-once + reused by the next suite
  // run (and by the local dev server on the same port)
}
