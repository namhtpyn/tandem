// DISPATCH-SCAN BOUNDING LAW (#130): the 5s dispatcher tick is never an
// unbounded table scan. These tests pin the SHAPES the tick actually issues:
// the eligible scan filters ready + AI-assignee in SQL, the reaper sweep never
// selects transcript columns, its marker is appended in the UPDATE's SQL, and
// live-run counts arrive in one GROUP BY.
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  eligibleTaskScan,
  idleSweepScan,
  livenessBounceWhere,
  liveRunsByAgent,
  reapOutputMarker,
  reapSweepScan,
} from '#server/domains/tasks/dispatcher.service';

import { mockDb } from './helpers/mock-db';

// EGRESS EXHAUSTION (#427): the idle-liveness bounce is a legal egress, and the scan's
// window admits a gating auto-block landing between the read and the write (a child spawn
// re-blocks its parent while the sweep holds the row). The CAS on the status this scan
// READ is what keeps it out of the block; a dropped status term re-opens the race with no
// other symptom, so the predicate's terms are pinned by shape.
describe('idle-liveness bounce predicate (#427)', () => {
  const flatten = (id: string, status: string) => {
    const { sql, params } = new PgDialect().sqlToQuery(livenessBounceWhere(id, status));
    return { flat: sql.replace(/\s+/g, ' ').toLowerCase(), params };
  };

  it('CASes on BOTH the id and the status the scan read', () => {
    const { flat, params } = flatten('task-1', 'doing-1');
    expect(flat).toContain('"id" =');
    expect(flat).toContain('"status" =');
    expect(params).toContain('task-1');
    expect(params).toContain('doing-1');
  });

  it('is an AND, never an OR — an OR would match every row on either term', () => {
    const { flat } = flatten('task-1', 'doing-1');
    expect(flat).toContain(' and ');
    expect(flat).not.toContain(' or ');
  });
});

describe('eligible-task scan shape (#130, #176)', () => {
  const CUTOFF = new Date('2026-11-01T00:00:00Z');

  it('filters ready-category + AI-assignee in the SQL WHERE', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks
      .findMany(eligibleTaskScan(['ready-1', 'ready-2'], ['jay', 'zed'], CUTOFF, 18))
      .toSQL();
    expect(sql).toContain('"status" in');
    expect(sql).toContain('"assignee_id" in');
    expect(params).toContain('ready-1');
    expect(params).toContain('jay');
  });

  it('pushes the elapsed-backoff predicate into the SQL WHERE (#176)', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.findMany(eligibleTaskScan(['r'], ['a'], CUTOFF, 17)).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('"dispatch_after" is null');
    expect(flat).toContain('or ("d0"."dispatch_after" <=');
  });

  it('is LIMIT-bounded (#176) and orders by created_at (oldest-first preserved)', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks.findMany(eligibleTaskScan(['r'], ['a'], CUTOFF, 33)).toSQL();
    expect(sql.replace(/\s+/g, ' ').toLowerCase()).toContain('limit $');
    expect(params).toEqual(expect.arrayContaining(['r', 'a', CUTOFF.toISOString(), 33]));
    expect(sql.replace(/\s+/g, ' ').toLowerCase()).toContain('order by "d0"."created_at" asc');
  });

  it('projects no oversized columns (no description, no output)', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.findMany(eligibleTaskScan(['r'], ['a'], CUTOFF, 17)).toSQL();
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

describe('liveness sweep shape (#225)', () => {
  const CUTOFF = new Date('2026-11-02T00:00:00Z');
  const MARGIN = 25;

  it('is ONE statement: the newest run arrives via a LATERAL join, never a per-row query', () => {
    const db = mockDb();
    const { sql } = idleSweepScan(db, CUTOFF, MARGIN).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('left join lateral');
    expect(flat).toContain('order by "task_runs"."started_at" desc');
  });

  it('pushes the no-live-run predicate into the WHERE', () => {
    const db = mockDb();
    const { sql, params } = idleSweepScan(db, CUTOFF, MARGIN).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('newest.status is null');
    expect(flat).toContain('newest.status <>');
    expect(params).toContain('RUNNING');
  });

  it('pushes the idle-past-grace predicate into the WHERE (coalesce of finished_at/updated_at)', () => {
    const db = mockDb();
    const { sql, params } = idleSweepScan(db, CUTOFF, MARGIN).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('coalesce(newest.finished_at');
    // raw sql template binds the Date as-is (RQB operators ISO-serialize, this path does not)
    expect(params.some((p: unknown) => p instanceof Date && p.getTime() === CUTOFF.getTime())).toBe(true);
  });

  it('filters working-category + AI-assignee in SQL and is LIMIT-bounded', () => {
    const db = mockDb();
    const { sql, params } = idleSweepScan(db, CUTOFF, MARGIN).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('"task_statuses"."category" =');
    expect(flat).toContain('"ai_employees"."user_id" =');
    expect(flat).toContain('limit $');
    expect(params).toContain(MARGIN);
  });

  it('projects no oversized columns (no description, no output)', () => {
    const db = mockDb();
    const { sql } = idleSweepScan(db, CUTOFF, MARGIN).toSQL();
    expect(sql.toLowerCase()).not.toContain('description');
    expect(sql.toLowerCase()).not.toContain('"output"');
  });
});
