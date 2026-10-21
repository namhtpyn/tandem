// The dispatchTask catch arm: a throwing ssh-exec surfaces as a failed run.
// Own file: vi.resetModules here cannot poison other suites' module graphs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './api-harness';
import { applyMigrations } from '../server/db/index';
import { STATUS } from '../shared/status';
import { resetSchema } from './helpers/pg';
import { ROLE, RUN_STATUS } from '../shared/enums';

process.env.TANDEM_FAKE_RUNNER = '';

const admin = { id: '00000000-0000-7000-8000-cd5fca5e2d34', name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN };

vi.mock('../server/domains/tasks/ssh-exec.util', () => ({
  // the ACP transport opens through loadClient — a throwing client loader is
  // today's equivalent of the old throwing ssh exec
  loadClient: async () => {
    throw new Error('ssh exploded');
  },
}));

beforeEach(async () => {
  await resetSchema();
  await applyMigrations();
  const { db } = await import('../server/db');
  const { user, environments, aiEmployees, tasks } = await import('../server/db/schema');
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-cd5fca5e2d34',
    name: 'Admin',
    email: 'admin@tandem.local',
    emailVerified: true,
    role: ROLE.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-79d931929132',
    name: 'Robby',
    email: 'robby@tandem.local',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(environments).values({
    id: 'env-1',
    name: 'E1',
    host: '127.0.0.1',
    port: '2222',
    username: '00000000-0000-7000-8000-51e69892ab49',
  });
  await db.insert(aiEmployees).values({
    userId: '00000000-0000-7000-8000-79d931929132',
    environmentId: 'env-1',
    instructions: '',
    executable: 'hermes acp',
  });
  await db.insert(tasks).values({
    id: 't-1',
    title: 'Boom',
    description: '',
    status: STATUS.todo,
    assigneeId: '00000000-0000-7000-8000-79d931929132',
  });
});

describe('dispatchTask catch arm', () => {
  it('a throwing ssh exec fails the run and logs the error', async () => {
    const { dispatchTask } = await import('../server/domains/tasks/runner.service');
    const handle = await dispatchTask('t-1', 'http://t.local');
    const res = await handle.finished;
    expect(res.status).toBe(RUN_STATUS.FAILED);
    const { db } = await import('../server/db');
    const { taskRuns } = await import('../server/db/schema');
    const run = (await db.select().from(taskRuns))[0]!;
    expect(run.output).toContain('ssh exploded');
    expect(run.status).toBe(RUN_STATUS.FAILED);
  }, 10_000);
});
