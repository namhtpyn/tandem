// Shared vitest helper: a REAL Postgres (Docker tandem-pg). Each test FILE gets
// its OWN DATABASE — created on import, dropped on afterAll — so parallel files
// never collide and the app's pooled client needs zero search_path hacks.
// App modules are imported lazily (in beforeAll) AFTER DATABASE_URL is pointed
// at this file's database, because server/db/index.ts reads DATABASE_URL at
// module scope.
import { afterAll, beforeAll } from 'vitest'
import postgresDriver from 'postgres'

const ROOT_URL = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test'
const u = new URL(ROOT_URL)
const DB_NAME = `t_${Math.random().toString(36).slice(2, 10)}`
export const TEST_DATABASE_URL = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port}/${DB_NAME}`

// admin client on the server (connect to the root/test database)
const admin = postgresDriver(ROOT_URL, { max: 1, onnotice: () => {} })

// our raw client into the fresh database
export const postgres = postgresDriver(TEST_DATABASE_URL, {
  max: 5,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
})

export async function resetSchema() {
  await postgres.unsafe('drop schema if exists public cascade')
  await postgres.unsafe('create schema public authorization tandem')
}

// Top-level: create the per-file database and point DATABASE_URL at it BEFORE
// any app module body executes (import order in test files puts this helper
// before '../server/db/index').
await admin.unsafe(`create database ${DB_NAME} owner tandem`)
process.env.DATABASE_URL = TEST_DATABASE_URL
const { applyMigrations, sqlClient } = await import('../../server/db/index')
await applyMigrations()

afterAll(async () => {
  try {
    await postgres.end()
    await sqlClient.end()
  } catch { /* pool may already be gone */ }
  try {
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`)
    await admin.end()
  } catch { /* best effort */ }
})
