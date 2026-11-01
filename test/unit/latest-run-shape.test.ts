// LATEST-RUN SHAPE (#163): every "is this the latest run of its task" check —
// the runner's bounce, the superseded-intent guard, the reaper's task bounce —
// shares ONE findFirst helper (newest started_at, LIMIT 1). The reaper's old
// copy fetched ALL runs of the task and JS-sorted: an unbounded scan.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { latestRunOfTaskScan } from '#server/domains/tasks/runner.service';

import { mockDb } from './helpers/mock-db';

describe('latest-run-of-task query shape (#163)', () => {
  it('one findFirst — newest started_at, LIMIT 1, id-only projection', () => {
    const db = mockDb();
    const { sql, params } = db.query.taskRuns.findFirst(latestRunOfTaskScan('task-1')).toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('order by');
    expect(flat).toContain('"started_at" desc');
    expect(flat).toMatch(/limit \$\d+/);
    expect(params).toContain(1);
    expect(flat).not.toContain('"output"');
    expect(flat).not.toContain('"prompt"');
    expect(params).toContain('task-1');
  });

  it('the helper is the single definition site and the reaper no longer fetch-alls + sorts', () => {
    const runner = readFileSync('server/domains/tasks/runner.service.ts', 'utf8');
    expect(runner.match(/latestRunIdForTask/g)?.length).toBeGreaterThanOrEqual(1);
    // exactly one findFirst uses the shared shape; no other newest-run copy remains
    expect(runner.match(/orderBy: \{ startedAt: 'desc' \},\n  \} as const/g)?.length).toBe(1);
    const dispatcher = readFileSync('server/domains/tasks/dispatcher.service.ts', 'utf8');
    expect(dispatcher).toContain('latestRunIdForTask');
    // the fetch-ALL + JS-sort copy is gone: no in-memory run sorting remains
    expect(dispatcher).not.toMatch(/\.sort\(/);
  });
});
