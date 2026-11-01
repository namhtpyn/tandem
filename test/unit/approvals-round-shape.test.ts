// SNAPSHOT-SLIMMING LAW (#130 slice 3): per-snapshot batch reads resolve each
// task's LATEST approval round in SQL (max(created_at) per task, joined back for
// that round only) and project only the columns their wire maps consume — never
// full obligation rows, never earlier rounds. These tests pin the SHAPES the
// wire actually issues; the dead-round → [] vs fulfilled-ids decision itself is
// not exported, so nothing here executes a query (mockDb throws on execute).
import { describe, expect, it } from 'vitest';

import { approvalsRoundScan, openObligationsScan } from '#server/domains/tasks/obligations.service';

import { mockDb } from './helpers/mock-db';

/** the SELECT list of the top-level query (before the first FROM), sorted */
const selectList = (sql: string) =>
  sql
    .slice(sql.indexOf('select ') + 'select '.length, sql.indexOf(' from '))
    .split(', ')
    .map((c) => c.trim())
    .sort();

describe('approvals latest-round scan shape (#130 slice 3)', () => {
  it('resolves the latest round in SQL: group by task over task_obligations with max(created_at)', () => {
    const { sql } = approvalsRoundScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(sql).toContain('group by "task_obligations"."task_id"');
    expect(sql).toContain('max("created_at") as "latest_at"');
  });

  it('joins back for that round only — task equality AND created_at = the per-task max', () => {
    const { sql } = approvalsRoundScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(sql).toContain('"latest_round"');
    expect(sql).toContain('"task_obligations"."task_id" = "latest_round"."task_id"');
    expect(sql).toContain('"task_obligations"."created_at" = "latest_round"."latest_at"');
  });

  it('projects exactly task_id / employee_id / status — never the full row', () => {
    const { sql } = approvalsRoundScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(selectList(sql)).toEqual([
      '"task_obligations"."employee_id"',
      '"task_obligations"."status"',
      '"task_obligations"."task_id"',
    ]);
    expect(sql).not.toContain('.*');
    expect(sql).not.toContain('"resolved_at"');
    expect(sql).not.toContain('"resolved_by"');
  });

  it('carries the APPROVAL role param and the per-task inArray params at both query levels', () => {
    const { sql, params } = approvalsRoundScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(sql).toContain('"task_obligations"."role" =');
    expect(sql).toContain('"task_obligations"."task_id" in');
    expect(params).toEqual(['t-1', 't-2', 'APPROVAL', 't-1', 't-2', 'APPROVAL']);
  });
});

describe('open-obligations scan shape (#130 slice 3)', () => {
  it('projects exactly task_id / employee_id / role — the columns the holders/approvers maps consume', () => {
    const { sql } = openObligationsScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(selectList(sql)).toEqual(['"employee_id"', '"role"', '"task_id"']);
    expect(sql).not.toContain('.*');
    expect(sql).not.toContain('"resolved_at"');
    expect(sql).not.toContain('"resolved_by"');
  });

  it('keeps the pending-only filter and the per-task inArray params', () => {
    const { sql, params } = openObligationsScan(mockDb(), ['t-1', 't-2']).toSQL();
    expect(sql).toContain('"task_obligations"."status" =');
    expect(sql).toContain('"task_obligations"."task_id" in');
    expect(params).toEqual(['t-1', 't-2', 'PENDING']);
  });
});
