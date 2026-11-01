// environments service: row mapping + list helpers

import { EmptyFilter, eq } from 'drizzle-orm';

import type { SecretUsage } from '#shared/enums';
import type { EnvironmentRow } from '#shared/types';
import { escapeIlike } from '#shared/utils/escape-ilike';

import { db } from '../../db/index';
import { environments as environmentsTable } from '../../db/schema';

export function toRow(
  r: Pick<
    typeof environmentsTable.$inferSelect,
    | 'id'
    | 'name'
    | 'host'
    | 'port'
    | 'username'
    | 'secretId'
    | 'secretUsage'
    | 'lastProbeOk'
    | 'lastProbeDetail'
    | 'lastProbeAt'
    | 'createdAt'
    | 'updatedAt'
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
    lastProbeOk: r.lastProbeOk,
    lastProbeDetail: r.lastProbeDetail,
    lastProbeAt: r.lastProbeAt ? r.lastProbeAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const ROW_COLUMNS = {
  id: true,
  name: true,
  host: true,
  port: true,
  username: true,
  secretId: true,
  secretUsage: true,
  lastProbeOk: true,
  lastProbeDetail: true,
  lastProbeAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listEnvironments() {
  const rows = await db.query.environments.findMany({
    columns: { ...ROW_COLUMNS },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRow);
}

export async function listEnvironmentsPaged(input: { page?: number; pageSize?: number; q?: string } = {}) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 10;
  const q = input.q?.trim();
  const { data, total } = await db.query.environments.findManyAndCount({
    columns: { ...ROW_COLUMNS },
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

/** PROBE VERDICT LAW: persist the probe outcome (success AND failure) on the
 *  row — the manager's Status column renders from this, never client state. */
export async function persistProbeVerdict(id: string, result: { ok: boolean; detail: string }) {
  await db
    .update(environmentsTable)
    .set({ lastProbeOk: result.ok, lastProbeDetail: result.detail, lastProbeAt: new Date() })
    .where(eq(environmentsTable.id, id));
}
