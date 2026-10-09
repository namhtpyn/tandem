// boot migrations: apply, idempotence, bundled-asset listing, fs fallback
import { describe, expect, it, beforeEach } from 'vitest'
import './helpers/pg'
import { resetSchema, postgres } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('applyMigrations', () => {
  beforeEach(async () => {
    await resetSchema()
  })

  it('creates tables and records migration names', async () => {
    const applied = await applyMigrations()
    expect(applied.length).toBeGreaterThanOrEqual(1)
    const tables = await postgres`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    const names = tables.map(r => r.table_name as string)
    expect(names).toContain('tandem_user')
    expect(names).toContain('tandem_session')
    expect(names).toContain('tandem_account')
    expect(names).toContain('tandem_verification')
    expect(names).toContain('tandem_settings')
    const recorded = await postgres`select name from tandem_migrations`
    expect(recorded.map(r => r.name as string).sort()).toEqual(applied.slice().sort())
  })

  it('is idempotent — second run applies nothing', async () => {
    await applyMigrations()
    const again = await applyMigrations()
    expect(again).toEqual([])
  })

  it('applies migrations from a filesystem dir (TANDEM_DRIZZLE_DIR override)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tandem-mig-'))
    try {
      const one = join(dir, '000001_first')
      mkdirSync(one)
      writeFileSync(join(one, 'migration.sql'), 'create table fs_probe (id text);--> statement-breakpoint\ncreate table fs_probe2 (id text);')
      process.env.TANDEM_DRIZZLE_DIR = dir
      // listMigrations prefers nitro storage when present (it is, under vitest?
      // no — useStorage is nitro-only; outside nitro the fs path runs)
      const applied = await applyMigrations()
      expect(applied).toContain('000001_first')
      const probe = await postgres`select count(*)::int as n from fs_probe`
      expect(probe[0]!.n).toBe(0) // table exists — query succeeded
    }
    finally {
      delete process.env.TANDEM_DRIZZLE_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns [] when the migrations dir does not exist', async () => {
    process.env.TANDEM_DRIZZLE_DIR = '/nonexistent-tandem-dir'
    try {
      expect(await applyMigrations()).toEqual([])
    }
    finally {
      delete process.env.TANDEM_DRIZZLE_DIR
    }
  })
})
