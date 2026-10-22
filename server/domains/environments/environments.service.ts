// environments service: row mapping + list helpers
import { desc } from 'drizzle-orm';

import { SECRET_USAGE, type SecretUsage } from '#shared/enums';

import type { EnvironmentRow } from '#shared/types';
import { db } from '../../db';
import { environments as environmentsTable } from '../../db/schema';

export function toRow(r: typeof environmentsTable.$inferSelect): EnvironmentRow {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    secretId: r.secretId,
    secretUsage: r.secretUsage as SecretUsage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listEnvironments() {
  const rows = await db.query.environments.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toRow);
}
