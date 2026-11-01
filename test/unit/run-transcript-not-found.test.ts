// NOT_FOUND contract pin (#148): the on-demand wire paths — tasks.runTranscript
// and tasks.getDescription — map a null fetch to ORPCError NOT_FOUND, never a
// raw 500 and never a fabricated row (RUN-TRANSCRIPT LAW / SNAPSHOT-SLIMMING
// LAW). The shape specs defer the execute path to here: these are the only
// unit probes that CALL the procedures (via the call() helper — valid session,
// no HTTP) with the db mocked to return no row.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      taskRuns: { findFirst: async () => undefined },
      tasks: { findFirst: async () => undefined },
    },
  },
}));

import { tasksRouter } from '#server/domains/tasks/tasks.router';

import { call } from './helpers/call';

describe('on-demand transcript paths: unknown ids (#148)', () => {
  it('tasks.runTranscript on an unknown runId rejects NOT_FOUND', async () => {
    await expect(call(tasksRouter.runTranscript, { runId: 'no-such-run' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('tasks.getDescription on an unknown taskId rejects NOT_FOUND', async () => {
    await expect(call(tasksRouter.getDescription, { taskId: 'no-such-task' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
