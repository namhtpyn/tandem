// environments service: row mapping + list helpers

import { EmptyFilter } from 'drizzle-orm';

import type { SecretUsage } from '#shared/enums';
import type { EnvironmentRow } from '#shared/types';
import { escapeIlike } from '#shared/utils/escape-ilike';

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

export async function listEnvironmentsPaged(input: { page?: number; pageSize?: number; q?: string } = {}) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 10;
  const q = input.q?.trim();
  const { data, total } = await db.query.environments.findManyAndCount({
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
    where: q
      ? {
          OR: [
            { name: { ilike: `%${escapeIlike(q)}%` } },
            { host: { ilike: `%${escapeIlike(q)}%` } },
            { username: { ilike: `%${escapeIlike(q)}%` } },
          ],
        }
      : EmptyFilter,
    orderBy: { createdAt: 'desc' },
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { environments: data.map(toRow), total };
}
