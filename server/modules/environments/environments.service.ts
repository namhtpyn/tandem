// environments service: row mapping + list helpers
import { desc } from 'drizzle-orm'
import { db } from '../../db'
import { environments as environmentsTable } from '../../db/schema'
import type { EnvironmentRow } from '../../../shared/types'

export function toRow(r: typeof environmentsTable.$inferSelect): EnvironmentRow {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    secretId: r.secretId,
    secretUsage: r.secretUsage as 'ssh-key' | 'password',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.select().from(environmentsTable).orderBy(desc(environmentsTable.createdAt))
  return rows.map(toRow)
}
