import { GenericContainer, Wait } from 'testcontainers';
// Suite-scoped Postgres + Redis via TestContainers. Runs ONCE in the main
// vitest process: starts containers, hands every worker its URL via `provide`,
// and stops them when the WHOLE suite finishes. Ryuk cleans up even if the
// process is killed mid-run — no orphaned containers, no name collisions.
// CI: service containers already exist (TANDEM_TEST_DATABASE_URL + REDIS_URL
// in the job env), so this is a pass-through.
import type { GlobalSetupContext } from 'vitest/node';

const PG_IMAGE = 'postgres:18-alpine';
const REDIS_IMAGE = 'redis:8-alpine';
const needsLocalContainers = !process.env.TANDEM_TEST_DATABASE_URL && !process.env.CI;

/** redis is a hard dependency — every suite run (dev or CI) gets a URL */
async function ensureRedis(ctx: GlobalSetupContext) {
  if (process.env.CI) {
    ctx.provide('redisUrl', process.env.REDIS_URL!);
    return;
  }
  const redis = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections', 1))
    .start();
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  ctx.provide('redisUrl', process.env.REDIS_URL);
}

let localPostgres: { stop: () => Promise<void> } | null = null;

export async function setup(ctx: GlobalSetupContext) {
  await ensureRedis(ctx);
  const { provide } = ctx;

  if (!needsLocalContainers) {
    const url = process.env.TANDEM_TEST_DATABASE_URL!;
    process.env.TANDEM_TEST_DATABASE_URL = url;
    provide('testDatabaseUrl', url);
    return;
  }

  const postgres = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: 'tandem', POSTGRES_PASSWORD: 'tandem', POSTGRES_DB: 'tandem_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();
  localPostgres = postgres;
  const url = `postgresql://tandem:tandem@${postgres.getHost()}:${postgres.getMappedPort(5432)}/tandem_test`;
  process.env.TANDEM_TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  // migrate ONCE for the whole run — tests only truncate data (resetData).
  // server/db asserts env at import: mirror setup.ts's test defaults first.
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod';
  process.env.TANDEM_VAULT_KEY = process.env.TANDEM_VAULT_KEY || Buffer.alloc(32, 7).toString('base64');
  const { applyMigrations, sqlClient } = await import('../server/db/index');
  await applyMigrations();
  await sqlClient.end();
  provide('testDatabaseUrl', url);
}

export async function teardown() {
  if (needsLocalContainers && localPostgres) {
    await localPostgres.stop();
  }
}
