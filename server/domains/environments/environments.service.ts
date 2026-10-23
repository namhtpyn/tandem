// environments service: row mapping + list helpers

import type { SecretUsage } from '#shared/enums';
import type { EnvironmentRow } from '#shared/types';

import { db } from '../../db/index';
import { environments as environmentsTable } from '../../db/schema';

export function toRow(
  r: Pick<
    typeof environmentsTable.$inferSelect,
    'id' | 'name' | 'host' | 'port' | 'username' | 'secretId' | 'secretUsage' | 'createdAt' | 'updatedAt'
  >,
): EnvironmentRow {
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
  const rows = await db.query.environments.findMany({
    columns: {
      id: true,
      name: true,
      host: true,
      port: true,
      username: true,
      secretId: true,
      secretUsage: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRow);
}
