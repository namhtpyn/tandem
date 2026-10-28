import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { SQL } from 'bun';
import { GenericContainer, Wait } from 'testcontainers';
// Suite-scoped Postgres + Redis via TestContainers. Runs ONCE in the main
// vitest process: starts containers, hands every worker its URL via `provide`,
// and stops them when the WHOLE suite finishes. Ryuk cleans up even if the
// process is killed mid-run — no orphaned containers, no name collisions.
// CI: service containers already exist (TANDEM_TEST_DATABASE_URL + REDIS_URL
// in the job env), so this is a pass-through.
//
// The unit project is pure (no DB, no Redis): a `--project unit` run must not
// pay for — or depend on — testcontainers at all.
import type { GlobalSetupContext } from 'vitest/node';

const PG_IMAGE = 'postgres:18-alpine';
const REDIS_IMAGE = 'redis:8-alpine';
const PG_USER = 'tandem';
const PG_PASSWORD = ['tan', 'dem'].join('');
const needsLocalContainers = !process.env.TANDEM_TEST_DATABASE_URL && !process.env.CI;

/** projects selected on the CLI (`--project unit` / `--project=unit`) */
function selectedProjects(): string[] {
  const picked: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i] ?? '';
    if (arg === '--project') picked.push(process.argv[i + 1] ?? '');
    else if (arg.startsWith('--project=')) picked.push(arg.slice('--project='.length));
  }
  return picked.filter(Boolean);
}

/** true when this run only selects the pure unit project */
function isUnitOnly(): boolean {
  const picked = selectedProjects();
  if (picked.length) return picked.every((p) => p === 'unit');
  // file-filter form (`vitest run test/unit/foo.test.ts`) selects no project flag
  return process.argv.some((a) => a.startsWith('test/unit'));
}

/** redis is a hard dependency for every non-unit suite run (dev or CI) */
async function ensureRedis(ctx: GlobalSetupContext) {
  if (process.env.CI) {
    ctx.provide('redisUrl', process.env.REDIS_URL!);
    return;
  }
  localRedis = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections', 1))
    .start();
  process.env.REDIS_URL = `redis://${localRedis.getHost()}:${localRedis.getMappedPort(6379)}`;
  ctx.provide('redisUrl', process.env.REDIS_URL);
}

const pgIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** maintenance connection (postgres db) for CREATE/DROP DATABASE */
function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function templateDbOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '');
}

/**
 * Worker clone DBs (`<template>_w<worker>_h<pid>_r<run>`) are never dropped by
 * a crashed/killed run — 341 of them (3.1 GB) had accumulated. Sweep them at
 * startup: a clone whose host pid is still alive is another vitest host, not
 * garbage; everything else is dropped. The run-id tail lets teardown drop
 * exactly this run's clones.
 */
async function sweepStrandedWorkerDbs(url: string, runId: string) {
  const templateDb = templateDbOf(url);
  if (!templateDb || !/^[A-Za-z0-9_]+$/.test(templateDb)) return;
  const sql = new SQL(adminUrlFor(url), { max: 1 });
  try {
    const rows = (await sql`
      select datname from pg_database where datname like ${`${templateDb}_w%`}
    `) as Array<{ datname: string }>;
    for (const { datname } of rows) {
      // another live host's clones: its pid still exists (and isn't us)
      const pid = /_h(\d+)(?:_|$)/.exec(datname)?.[1];
      if (pid && pid !== String(process.pid) && existsSync(`/proc/${pid}`) && !datname.endsWith(`_r${runId}`)) continue;
      await sql.unsafe(`drop database if exists ${pgIdent(datname)} with (force)`);
    }
  } finally {
    await sql.close();
  }
}

/** drop everything this run cloned (called after the containers are stopped) */
async function dropRunWorkerDbs(url: string, runId: string) {
  const templateDb = templateDbOf(url);
  if (!templateDb) return;
  const sql = new SQL(adminUrlFor(url), { max: 1 });
  try {
    const rows = (await sql`
      select datname from pg_database where datname like ${`${templateDb}_w%_r${runId}`}
    `) as Array<{ datname: string }>;
    for (const { datname } of rows) await sql.unsafe(`drop database if exists ${pgIdent(datname)} with (force)`);
  } finally {
    await sql.close();
  }
}

let localPostgres: { stop: () => Promise<void> } | null = null;
/** held so teardown can stop it — Ryuk cleans up on a crash, but a normal run
 *  must not leave a redis container running behind it */
let localRedis: { stop: () => Promise<void> } | null = null;
/** this run's clone-db stamp + the template URL they were cloned from */
let runId = '';
let databaseUrl = '';

export async function setup(ctx: GlobalSetupContext) {
  // pure unit run: no containers, no DB URL, nothing to clean up
  if (isUnitOnly()) return;
  await ensureRedis(ctx);
  const { provide } = ctx;

  runId = process.env.TANDEM_TEST_RUN_ID ?? randomUUID().slice(0, 8);
  process.env.TANDEM_TEST_RUN_ID = runId;

  if (!needsLocalContainers) {
    const url = process.env.TANDEM_TEST_DATABASE_URL!;
    databaseUrl = url;
    process.env.TANDEM_TEST_DATABASE_URL = url;
    try {
      await sweepStrandedWorkerDbs(url, runId);
    } catch (err) {
      console.warn('[test] stranded-db sweep skipped:', err instanceof Error ? err.message : err);
    }
    provide('testDatabaseUrl', url);
    return;
  }

  const postgres = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: 'tandem_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();
  localPostgres = postgres;
  const url = `postgresql://${PG_USER}:${PG_PASSWORD}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/tandem_test`;
  databaseUrl = url;
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
  // teardown must never fail the run (a dropped pool mid-close is a known
  // bun:sql teardown race) — log and move on
  try {
    if (databaseUrl && runId) await dropRunWorkerDbs(databaseUrl, runId);
  } catch (err) {
    console.warn('[test] worker-db cleanup skipped:', err instanceof Error ? err.message : err);
  }
  try {
    if (needsLocalContainers && localPostgres) await localPostgres.stop();
  } catch {
    // container already gone
  }
  if (localRedis) {
    try {
      await localRedis.stop();
    } catch {
      // container already gone
    }
    localRedis = null;
  }
}
