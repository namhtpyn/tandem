// RUN LOCK wire bit (#264): the batched live-run lookup behind tasks.list /
// tasks.listPaged rows. Pins (a) the SQL contract — ONE inner-joined select over
// the page's task ids filtered to RUNNING runs (runs reach the task through
// their thread message; task_runs has no task_id), never a per-row lookup — and
// (b) the Set mapping with the empty-page short-circuit.
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';

import { mockDb, taskMessages, taskRuns } from './helpers/mock-db';

const h = vi.hoisted(() => ({ selectCalls: 0 }));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    // fake chain: from().innerJoin().where() resolving to joined rows (the impl
    // awaits the builder directly)
    select: () => {
      h.selectCalls++;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => ({
          then: (onF?: (v: Array<{ taskId: string }>) => unknown) =>
            Promise.resolve([{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'a' }]).then(onF),
        }),
      };
      return chain as never;
    },
    query: {},
  },
}));

import { runningTaskIdsFor } from '../../server/domains/tasks/runner.service';

describe('runningTaskIdsFor — the RUN LOCK bit query (#264)', () => {
  it('SQL shape: task_runs ⋈ task_messages on message_id, RUNNING filter, page ids in one inArray', () => {
    const db = mockDb();
    const { sql, params } = db
      .select({ taskId: taskMessages.taskId })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskRuns.messageId, taskMessages.id))
      .where(and(inArray(taskMessages.taskId, ['t-1', 't-2']), eq(taskRuns.status, RUN_STATUS.RUNNING)))
      .toSQL();
    expect(sql.toLowerCase()).toContain('inner join "task_messages"');
    expect(sql).toContain('"task_runs"."status"');
    expect(sql.toLowerCase()).toContain('in (');
    expect(params).toContain(RUN_STATUS.RUNNING);
    expect(params).toContain('t-1');
    expect(params).toContain('t-2');
    // the lock read never drags transcript text (SNAPSHOT-SLIMMING law family)
    expect(sql.toLowerCase()).not.toContain('output');
  });

  it('maps the joined rows onto a deduped task-id Set with ONE select', async () => {
    h.selectCalls = 0;
    const ids = await runningTaskIdsFor(['a', 'b']);
    expect(ids.size).toBe(2);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(h.selectCalls).toBe(1);
  });

  it('an empty page short-circuits — no query at all', async () => {
    h.selectCalls = 0;
    const ids = await runningTaskIdsFor([]);
    expect(ids.size).toBe(0);
    expect(h.selectCalls).toBe(0);
  });
});
