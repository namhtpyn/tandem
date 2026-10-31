// DISPATCH-SCAN BOUNDING LAW (#130): the 5s dispatcher tick is never an
// unbounded table scan. These tests pin the SHAPES the tick actually issues:
// the eligible scan filters ready + AI-assignee in SQL, the reaper sweep never
// selects transcript columns, its marker is appended in the UPDATE's SQL, and
// live-run counts arrive in one GROUP BY.
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  eligibleTaskScan,
  liveRunsByAgent,
  reapOutputMarker,
  reapSweepScan,
} from '#server/domains/tasks/dispatcher.service';

import { mockDb } from './helpers/mock-db';

describe('eligible-task scan shape (#130)', () => {
  it('filters ready-category + AI-assignee in the SQL WHERE', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks.findMany(eligibleTaskScan(['ready-1', 'ready-2'], ['jay', 'zed'])).toSQL();
    expect(sql).toContain('"status" in');
    expect(sql).toContain('"assignee_id" in');
    expect(params).toEqual(['ready-1', 'ready-2', 'jay', 'zed']);
  });

  it('orders by created_at (oldest-first claim preserved in SQL)', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.findMany(eligibleTaskScan(['r'], ['a'])).toSQL();
    expect(sql.replace(/\s+/g, ' ').toLowerCase()).toContain('order by "d0"."created_at" asc');
  });

  it('projects no oversized columns (no description, no output)', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.findMany(eligibleTaskScan(['r'], ['a'])).toSQL();
    expect(sql.toLowerCase()).not.toContain('description');
    expect(sql.toLowerCase()).not.toContain('output');
  });
});

describe('reaper sweep shape (#130)', () => {
  it('selects id/started_at only — the transcript never crosses the wire', () => {
    const db = mockDb();
    const { sql } = db.query.taskRuns.findMany(reapSweepScan(new Date(0))).toSQL();
    expect(sql.toLowerCase()).not.toContain('"output"');
    expect(sql.toLowerCase()).not.toContain('"prompt"');
    expect(sql.toLowerCase()).toContain('"started_at"');
  });

  it('pushes RUNNING + the timeout cutoff into the WHERE (rides task_runs_status_idx)', () => {
    const db = mockDb();
    const { sql, params } = db.query.taskRuns.findMany(reapSweepScan(new Date('2026-10-31T00:00:00Z'))).toSQL();
    expect(sql).toContain('"status" =');
    expect(sql).toContain('"started_at" <=');
    expect(params).toContain('RUNNING');
  });
});

describe('reaper marker SQL (#130)', () => {
  it('appends the timed-out marker against the stored output — never by re-reading it', () => {
    const { sql, params } = new PgDialect().sqlToQuery(reapOutputMarker(30));
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain("'[reaper] run timed out'");
    expect(sql).toContain('||');
    expect(params.some((p) => String(p).includes('[reaper] run timed out after 30 min'))).toBe(true);
  });
});

describe('live-run counts shape (#130)', () => {
  it('one GROUP BY query — not a serialized COUNT per candidate', () => {
    const db = mockDb();
    const { sql, params } = liveRunsByAgent(db, ['jay', 'zed']).toSQL();
    expect(sql.toLowerCase()).toContain('count(*)');
    expect(sql.toLowerCase()).toContain('group by "task_runs"."employee_id"');
    expect(sql).toContain('"task_runs"."status" =');
    expect(sql).toContain('"task_runs"."employee_id" in');
    expect(params).toEqual(['RUNNING', 'jay', 'zed']);
  });
});
