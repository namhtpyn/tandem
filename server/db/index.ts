// Postgres client (postgres.js) + drizzle rc (Relations v2) + boot-applied migrations.
//
// Env:
//   DATABASE_URL            — postgres://user:pass@host:port/db (required in prod)
//   TANDEM_DRIZZLE_DIR      — migrations dir override (default ./drizzle)
//
// Migrations are drizzle-kit SQL folders applied at boot, tracked in tandem_migrations.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  user, session, account, verification, settings,
  relations,
} from './schema'

const url = process.env.DATABASE_URL
/* v8 ignore start -- unit tests exercise this via a child process */
if (!url) {
  // eslint-disable-next-line no-console
  console.error('[tandem] DATABASE_URL is required')
  process.exit(1)
}
/* v8 ignore stop */

// runner-side client: prepare false keeps boot-time DDL safe with pgbouncer-ish pools
export const sqlClient = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
})

// ---------- boot migrations ----------

interface MigrationSource {
  name: string // folder name, e.g. 20261009133348_hard_weapon_omega
  sql: string
}

async function listMigrations(): Promise<MigrationSource[]> {
  // bundled nitro serverAssets: mounted at /assets, keys like "drizzle:2026...:migration.sql"
  /* v8 ignore start -- nitro-runtime branch: exercised by the real server in E2E */
  try {
    const storage = useStorage()
    const keys: string[] = await storage.getKeys('assets:drizzle:')
    const sqlKeys = keys.filter(k => k.endsWith('.sql')).sort()
    const out: MigrationSource[] = []
    for (const key of sqlKeys) {
      const name = key.replace(/^assets:drizzle:/, '').replace(/:migration\.sql$/, '')
      const raw = await storage.getItem(key)
      if (typeof raw === 'string') out.push({ name, sql: raw })
    }
    if (out.length > 0) return out
  }
  catch (e) {
    // no nitro storage context (standalone scripts) — fall through

  }
  // 2) filesystem fallback (dev / TANDEM_DRIZZLE_DIR override)
  const drizzleDir = process.env.TANDEM_DRIZZLE_DIR || join(process.cwd(), 'drizzle')
  try {
    const dirs = readdirSync(drizzleDir).filter(d => /^\d+_/.test(d)).sort()
    return dirs.flatMap((dir) => {
      const sqlFile = readdirSync(join(drizzleDir, dir)).find(f => f.endsWith('.sql'))
      if (!sqlFile) return []
      return [{ name: dir, sql: readFileSync(join(drizzleDir, dir, sqlFile), 'utf8') }]
    })
  }
  catch {
    return []
  }
}

export async function applyMigrations(): Promise<string[]> {
  const applied: string[] = []
  await sqlClient`create table if not exists tandem_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`
  const migrations = await listMigrations()
  for (const m of migrations) {
    const already = await sqlClient`select 1 from tandem_migrations where name = ${m.name}`
    if (already.length > 0) continue
    const stmts = m.sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)
    // one transaction per migration folder
    await sqlClient.begin(async (tx) => {
      for (const stmt of stmts) await tx.unsafe(stmt)
      await tx`insert into tandem_migrations (name) values (${m.name})`
    })
    applied.push(m.name)
  }
  return applied
}

export const db = drizzle({ client: sqlClient, relations })
