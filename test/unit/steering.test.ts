// Composer law (owner ruling 2026-10-27): sending a message STEERS a live run;
// sending while stopped dispatches. The lookup must read the RUNS table — the
// thread's newest message is a bare note (dual-write, 2026-10-26) and poisoned
// the old message-first lookup into always answering "stopped".
import { describe, expect, it } from 'vitest';

import { liveRunsQuery, pickLiveRun } from '#server/domains/tasks/runner.service';
import { RUN_STATUS } from '#shared/enums';

import { mockDb } from './helpers/mock-db';

const run = (id: string, status: string) => ({ id, status });

describe('pickLiveRun (steering/run-lock lookup)', () => {
  it('finds the RUNNING run even when a newer bare note exists (the poison case)', () => {
    // newest-first as the runs query returns them: the run row itself is what
    // counts — a newer thread note never hides a live run again
    const candidates = [run('stale-done', RUN_STATUS.DONE), run('live-1', RUN_STATUS.RUNNING)];
    expect(pickLiveRun(candidates)).toBe('live-1');
  });

  it('newest RUNNING wins when several rows are RUNNING', () => {
    const candidates = [run('newer', RUN_STATUS.RUNNING), run('older', RUN_STATUS.RUNNING)];
    expect(pickLiveRun(candidates)).toBe('newer');
  });

  it('no live run → null (composer may dispatch)', () => {
    expect(pickLiveRun([run('r1', RUN_STATUS.DONE), run('r2', RUN_STATUS.FAILED)])).toBeNull();
    expect(pickLiveRun([])).toBeNull();
  });

  it('terminal states never steer', () => {
    expect(pickLiveRun([run('r1', RUN_STATUS.DONE)])).toBeNull();
    expect(pickLiveRun([run('r1', RUN_STATUS.FAILED)])).toBeNull();
  });
});

describe('liveRunsQuery shape', () => {
  it('reads task_runs joined to their message — never newest-message-first', () => {
    const db = mockDb();
    const { sql, params } = db.query.taskRuns.findMany(liveRunsQuery('task-1')).toSQL();
    expect(sql).toContain('task_runs');
    expect(sql).toContain('task_messages');
    expect(params).toContain('task-1');
    expect(sql).not.toContain('task_messages" order by'); // no messages-first ordering
  });
});
