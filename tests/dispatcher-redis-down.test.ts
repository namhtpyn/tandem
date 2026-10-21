// Redis-down arm: scanOnce must return false (not throw) when enqueue fails.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './api-harness';
import { resetSchema } from './helpers/pg';
import { applyMigrations } from '../server/db/index';
import { ROLE } from '../shared/enums';
import { STATUS } from '../shared/status';

vi.mock('../server/domains/kernel/queue', () => ({
  redisQueue: async () => ({
    queue: async () => ({ close: async () => {} }),
    enqueue: async () => {
      throw new Error('ECONNREFUSED');
    },
    close: async () => {},
  }),
}));
vi.mock('../server/domains/kernel/pubsub', () => ({
  redisPubsub: async () => null,
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
    title: 'Down',
    description: '',
    status: STATUS.todo,
    assigneeId: '00000000-0000-7000-8000-79d931929132',
  });
});

describe('dispatch with redis down', () => {
  it('enqueue failure yields false without throwing', async () => {
    const { scanOnce } = await import('../server/domains/tasks/dispatcher.service');
    expect(await scanOnce('http://t.local')).toBe(false);
  });
});
