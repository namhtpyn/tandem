import { eq } from 'drizzle-orm';

import './api-harness';
// Audit round 8 — run-thread publish ordering.
// The dispatch note (task_activity) is inserted before the run row; the
// TASK_ACTIVITY publish must come AFTER createRunMessage + the task_runs insert,
// and finish() must publish again after the thread body is rewritten. Otherwise a
// listener rebuilding off the first ping caches a thread without the run bubble,
// and never sees the settled result.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const state = vi.hoisted(() => ({
  watchTaskId: '',
  snaps: [] as Array<{ messages: number; hasRun: boolean; bodies: string[] }>,
}));

vi.mock('#server/domains/kernel/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#server/domains/kernel/kernel')>();
  return {
    ...actual,
    // snapshot the thread at publish time; the runner awaits publishChange, so the
    // recorded order is the real order
    publishChange: async (
      resource: Parameters<typeof actual.publishChange>[0],
      action: Parameters<typeof actual.publishChange>[1],
    ) => {
      if (resource === 'TASK_ACTIVITY' && state.watchTaskId) {
        const { db } = await import('#server/db');
        const { taskMessages, taskRuns } = await import('#server/db/schema');
        const messages = await db.select().from(taskMessages).where(eq(taskMessages.taskId, state.watchTaskId));
        const runs = await db.select().from(taskRuns);
        state.snaps.push({
          messages: messages.length,
          hasRun: runs.some((r) => messages.some((m) => m.id === r.messageId)),
          bodies: messages.map((m) => m.body),
        });
      }
      await actual.publishChange(resource, action);
    },
  };
});

const ADMIN_ID = '00000000-0000-7000-8000-cd5fca5e2d34';
const AI_ID = '00000000-0000-7000-8000-79d931929132';
const TASK_ID = 't-1';

beforeEach(async () => {
  state.watchTaskId = '';
  state.snaps.length = 0;
  const { db } = await import('#server/db');
  const { user, environments, aiEmployees, tasks } = await import('#server/db/schema');
  await db.insert(user).values({ id: ADMIN_ID, name: 'Admin', email: 'admin@tandem.local', role: 'ADMIN' });
  await db.insert(user).values({ id: AI_ID, name: 'Robby', email: 'robby@tandem.local' });
  await db
    .insert(environments)
    .values({ id: 'env-1', name: 'E1', host: '127.0.0.1', port: '2222', username: 'tandem' });
  await db.insert(aiEmployees).values({ userId: AI_ID, environmentId: 'env-1', executable: 'hermes acp' });
  await db.insert(tasks).values({ id: TASK_ID, title: 'Publish order', status: STATUS.todo, assigneeId: AI_ID });
});

describe('runner thread publishes', () => {
  it('publishes TASK_ACTIVITY only once the run turn exists, and again after the body settles', async () => {
    const { setEnv } = await import('#server/domains/kernel/env');
    setEnv({ TANDEM_FAKE_RUNNER: '1' });
    try {
      state.watchTaskId = TASK_ID;
      const { dispatchTask } = await import('#server/domains/tasks/runner.service');
      const handle = await dispatchTask(TASK_ID, 'http://t.local');
      const res = await handle.finished;
      expect(res.status).toBe(RUN_STATUS.DONE);

      expect(state.snaps.length).toBeGreaterThanOrEqual(2);
      // first ping: the run message already exists (a thread rebuild sees the bubble)
      expect(state.snaps[0]).toMatchObject({ messages: 1, hasRun: true });
      // finish(): a later ping carries the parsed result, not the blank turn
      const settled = state.snaps.filter((s) => s.bodies.some((b) => b.length > 0));
      expect(settled.length).toBeGreaterThan(0);
      expect(state.snaps.at(-1)!.bodies.join('')).toContain('task complete');
    } finally {
      setEnv({ TANDEM_FAKE_RUNNER: undefined });
    }
  }, 30_000);
});
