// DISPATCH MISS LAW (#386 r5): the manual dispatch verb read the task with
// `nonNull(rows[0])` — an unknown / padded / malformed taskId threw a raw
// TypeError out of the handler (opaque 500) because requireDispatchable runs
// OUTSIDE runWorkflow's error mapping. A miss must answer the ordinary
// NOT_FOUND the other by-id verbs answer.
import { createProcedureClient } from '@orpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE } from '#shared/enums';

const h = vi.hoisted(() => ({ taskReads: [] as unknown[][] }));

vi.mock('../../server/db/index', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/db/index');
  return {
    ...actual,
    db: {
      query: {
        tasks: { findMany: async () => h.taskReads.shift() ?? [] },
        taskStatuses: { findMany: async () => [] },
        taskRuns: { findFirst: async () => null },
      },
    },
  };
});

const { tasksRouter } = await import('../../server/domains/tasks/tasks.router');

const session = { user: { id: 'u1', role: ROLE.ADMIN, name: 'Unit', email: 'unit@tandem.local' } };

function dispatchClient() {
  return createProcedureClient(
    tasksRouter.dispatch as never,
    {
      context: {
        session,
        getSession: async () => session,
        reqHeaders: undefined,
      },
    } as never,
  ) as (input: { taskId: string }) => Promise<unknown>;
}

describe('manual dispatch on an unknown task (#386)', () => {
  beforeEach(() => {
    h.taskReads.length = 0;
  });

  it('answers NOT_FOUND, never a raw 500', async () => {
    h.taskReads.push([]); // the task lookup misses
    await expect(dispatchClient()({ taskId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a padded id is an ordinary miss (the schema keeps it a read key)', async () => {
    h.taskReads.push([]);
    await expect(dispatchClient()({ taskId: ' 0190f3f1-0000-7000-8000-000000000001 ' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
