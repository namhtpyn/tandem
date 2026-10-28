import './api-harness';
// Audit round 8 — tasks.assignments must mirror the reviewerNames fallback: a
// ledger row whose employee is missing from the user snapshot renders with a null
// name instead of throwing (nonNull(...) made the whole procedure 500).
import { describe, expect, it, vi } from 'vitest';

import { ROLE } from '#shared/enums';

import { makeProcCaller } from './helpers/procs.ts';

const GHOST_ID = '00000000-0000-7000-8000-0000000000ff';
const TASK_ID = 't-assign-ghost';

vi.mock('#server/domains/tasks/assignments.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#server/domains/tasks/assignments.service')>();
  return {
    ...actual,
    listAssignments: async () => [
      {
        id: 'assignment-ghost',
        taskId: TASK_ID,
        employeeId: GHOST_ID, // no such user row (deleted/renamed mid-flight)
        reason: 'auto',
        actorId: null,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: null,
      },
    ],
  };
});

const proc = await makeProcCaller({
  id: '00000000-0000-7000-8000-c5ea71554c77',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
});

describe('tasks.assignments', () => {
  it('returns a null employeeName when the employee row is gone', async () => {
    const res = (await proc('tasks.assignments', { taskId: TASK_ID })) as {
      items: Array<{ employeeId: string | null; employeeName: string | null; reason: string }>;
    };
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ employeeId: GHOST_ID, employeeName: null, reason: 'auto' });
  });
});
