// Dispatch cap law (2026-10-16, enforced at claim time 2026-10-29): one concurrent
// task per agent by default. The claim (run row RUNNING + task doing) must never
// outrun the agent's slot count — queue concurrency alone let a second task flash
// "running" while its turn sat in the queue.
import { describe, expect, it } from 'vitest';

import { atCap } from '#server/domains/tasks/dispatcher.service';

import { mockDb } from './helpers/mock-db';

describe('atCap (dispatch cap decision)', () => {
  it('blocks an agent already at its cap', () => {
    expect(atCap(1, 1)).toBe(true);
    expect(atCap(2, 1)).toBe(true);
    expect(atCap(3, 2)).toBe(true);
  });

  it('allows an agent with a free slot', () => {
    expect(atCap(0, 1)).toBe(false);
    expect(atCap(1, 2)).toBe(false);
  });

  it('cap 0 blocks everything (defensive)', () => {
    expect(atCap(0, 0)).toBe(true);
  });

  it('liveRunCount filter renders on task_runs (employee + RUNNING only)', () => {
    const db = mockDb();
    const { sql, params } = db.query.taskRuns.count({ employeeId: { eq: 'jay' }, status: { eq: 'RUNNING' } }).toSQL();
    expect(sql).toContain('task_runs');
    expect(sql).toContain('employee_id');
    expect(params).toContain('jay');
    expect(params).toContain('RUNNING');
  });
});
