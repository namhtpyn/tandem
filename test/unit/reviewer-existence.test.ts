// REVIEWER EXISTENCE (#361) — write edge: tasks.reviewers is a text[] with NO FK,
// so an id that names no user used to sail through create/update and only blow up
// at submit (task_reviews.reviewer_id FK -> 23503 -> driver 500). The check runs
// at the write edge, but ids ALREADY STORED on the task are grandfathered: a
// departed employee's id must not make a legacy task un-editable.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isUuid } from '#shared/utils/is-uuid';

const ABSENT = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
const OTHER_ABSENT = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const PRESENT = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const PRESENT2 = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  roundLive: false,
  users: [] as Array<{ id: string }>,
  statuses: [] as Array<{ id: string; category: string }>,
  inserted: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {
        tasks: { findMany: async () => h.taskRows },
        taskStatuses: { findMany: async () => h.statuses },
        user: {
          // predicate-faithful mock: only ids the WHERE names come back, so a
          // candidate set that skipped canonicalization can never pass silently
          findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
            const ids = args?.where?.id?.in;
            // uuid-column faithful: a non-uuid value bound to user.id raises 22P02
            if (ids?.some((id) => !isUuid(id))) throw new Error('invalid input syntax for type uuid');
            return ids ? h.users.filter((u) => ids.includes(u.id)) : h.users;
          },
        },
      },
      insert: () => ({
        values: async (vals: Record<string, unknown>) => {
          h.inserted.push(vals);
        },
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: async () => {
            if (table === tasks) h.updates.push(vals);
          },
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return { ...mod, openRoundLive: async () => h.roundLive };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { tasksRouter } from '#server/domains/tasks/tasks.router';

import { call } from './helpers/call';

beforeEach(() => {
  h.taskRows = [];
  h.roundLive = false;
  h.users = [{ id: PRESENT }, { id: PRESENT2 }];
  h.statuses = [{ id: 'st-todo', category: 'ready' }];
  h.inserted = [];
  h.updates = [];
});

describe('reviewer existence at the write edge (#361)', () => {
  it('create refuses a reviewer that names no user with BAD_REQUEST — never a 500 at submit', async () => {
    await expect(call(tasksRouter.create, { title: 't', reviewers: [ABSENT] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'reviewer does not exist',
    });
    expect(h.inserted).toHaveLength(0);
  });

  it('create accepts a reviewer that names an existing user', async () => {
    await call(tasksRouter.create, { title: 't', reviewers: [PRESENT] });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]?.reviewers).toEqual([PRESENT]);
  });

  it('update refuses a NEW reviewer that names no user and writes nothing', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [] }];
    await expect(call(tasksRouter.update, { id: 'task-1', reviewers: [ABSENT] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'reviewer does not exist',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('update keeps a STALE stored reviewer editable — a departed employee cannot freeze the task', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [ABSENT] }];
    await call(tasksRouter.update, { id: 'task-1', title: 'renamed', reviewers: [ABSENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('grandfathering is case-insensitive (UUID-CASE LAW) — an uppercase legacy id is the same reviewer', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [ABSENT.toUpperCase()] }];
    await call(tasksRouter.update, { id: 'task-1', title: 'renamed', reviewers: [ABSENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('update validates only ids NOT already stored — an added absent id still refuses', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [ABSENT] }];
    await expect(call(tasksRouter.update, { id: 'task-1', reviewers: [ABSENT, OTHER_ABSENT] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'reviewer does not exist',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('create refuses when a LIVE reviewer is mixed with an absent one — one miss refuses the whole roster', async () => {
    await expect(call(tasksRouter.create, { title: 't', reviewers: [PRESENT, ABSENT] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'reviewer does not exist',
    });
    expect(h.inserted).toHaveLength(0);
  });

  it('update accepts a stored stale id kept beside a NEW live reviewer — only the new id is validated', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [ABSENT] }];
    await call(tasksRouter.update, { id: 'task-1', reviewers: [ABSENT, PRESENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('a case-variant echo of the stored roster does NOT count as a change — no false round-lock', async () => {
    h.roundLive = true;
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [PRESENT.toUpperCase()] }];
    await call(tasksRouter.update, { id: 'task-1', reviewers: [PRESENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('a GENUINE roster change while a round is live refuses with the lock message', async () => {
    h.roundLive = true;
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [] }];
    await expect(call(tasksRouter.update, { id: 'task-1', reviewers: [PRESENT] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'a review round is in progress — reviewers are locked until it is decided',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('reordering the roster is not a roster change — no round-lock refusal during a live round', async () => {
    h.roundLive = true;
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [PRESENT, PRESENT2] }];
    await call(tasksRouter.update, { id: 'task-1', reviewers: [PRESENT2, PRESENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('a braced legacy stored id is grandfathered against its canonical echo', async () => {
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [`{${ABSENT}}`] }];
    await call(tasksRouter.update, { id: 'task-1', title: 'renamed', reviewers: [ABSENT] });
    expect(h.updates).toHaveLength(1);
  });

  it('a legacy double-spelling of the SAME stored reviewer is a no-op echo — not a roster change', async () => {
    h.roundLive = true;
    h.taskRows = [{ status: 'st-todo', assigneeId: null, reviewers: [PRESENT, `{${PRESENT}}`] }];
    await call(tasksRouter.update, { id: 'task-1', reviewers: [PRESENT] });
    expect(h.updates).toHaveLength(1);
  });
});
