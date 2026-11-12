// REVIEW SETTLE-FAILURE PARK (#199): parkRound parks ONLY from in-review — a manual
// settle that won the race owns the outcome (parking over a terminal/owner-moved
// status would resurrect a dead round), and the park write carries the atomic
// in-review predicate so a concurrent settle between read and write wins.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

import { mockDb, tasks as dbTasks } from './helpers/mock-db';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; hasPredicate: boolean; cond: unknown }>,
  activities: [] as Array<{ body: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: () => ({
          where: async () => h.taskRows,
        }),
      }),
      query: {
        // CATEGORY-GATE LAW (#336): parkRound resolves the read status's category
        taskStatuses: {
          findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
            const rows = [
              { id: STATUS.inReview, category: 'in_review' },
              { id: STATUS.done, category: 'done' },
              { id: STATUS.cancelled, category: 'cancelled' },
              { id: 'st-custom-review', category: 'in_review' },
              { id: STATUS.blocked, category: 'paused' },
              { id: 'st-working', category: 'working' },
            ];
            const id = args?.where?.id?.eq;
            return id ? rows.filter((r) => r.id === id) : rows;
          },
        },
      },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const applied = () => {
              h.updates.push({ table: table === tasks ? 'tasks' : 'other', set, hasPredicate: cond != null, cond });
              // parkRound's guarded write now .returning()s the flipped rows (#282):
              // the atomic predicate decides the flip — here the guard always wins
              return cond != null ? [{ id: 'task-1' }] : [];
            };
            return {
              then: <R>(onFulfilled?: (v: Array<Record<string, unknown>>) => R) =>
                Promise.resolve(applied()).then(onFulfilled),
              returning: async () => applied(),
            };
          },
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string; payload: Record<string, unknown> }) => {
      h.activities.push({ body: args.body, payload: args.payload });
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

import { parkRound } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.taskRows = [];
  h.updates = [];
  h.activities = [];
});

describe('parkRound in-review guard (#199)', () => {
  it('a task that left in-review (manual settle won) is NOT parked', async () => {
    h.taskRows = [{ status: STATUS.done, ownerId: 'u1' }];
    await parkRound('task-1', 'review turn timed out — reaped after 45 min');
    expect(h.updates).toHaveLength(0);
    expect(h.activities).toHaveLength(0);
  });

  it('an in-review task parks: BLOCKED write with the atomic predicate + thread note', async () => {
    h.taskRows = [{ status: STATUS.inReview, ownerId: 'u1' }];
    await parkRound('task-1', 'review turn timed out — reaped after 45 min');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.table).toBe('tasks');
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.hasPredicate).toBe(true);
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]?.body).toContain('review parked — review turn timed out');
  });

  it('the park write carries park-origin memory (#202): park_from_status = the in-review status', async () => {
    h.taskRows = [{ status: STATUS.inReview, ownerId: 'u1' }];
    await parkRound('task-1', 'escalation stalled — no eligible supervisor');
    expect(h.updates[0]?.set.parkFromStatus).toBe(STATUS.inReview);
  });

  it('an IN-REVIEW task carrying a stale park origin still parks (#419: the memory term is block-scoped)', async () => {
    // a settle-matrix flip out of a park writes only the status; a resubmit brings the
    // origin back into in-review. The status write is that branch's arbiter — refusing
    // here would wedge every later park of the round.
    h.taskRows = [{ status: STATUS.inReview, ownerId: 'u1', rearmAttempts: 0, parkFromStatus: STATUS.inReview }];
    const parked = await parkRound('task-1', 'review turn timed out — reaped after 45 min', { rearmable: true });
    expect(parked).toBe(true);
    expect(h.updates[0]?.set.parkFromStatus).toBe(STATUS.inReview);
    // the park-once term is BLOCK-scoped: this branch's arbiter is the status write
    const rendered = mockDb()
      .select()
      .from(dbTasks)
      .where(h.updates[0]?.cond as never)
      .toSQL();
    expect(rendered.sql.replace(/\s+/g, ' ').toLowerCase()).not.toContain('"tasks"."park_from_status" is null');
  });

  it('the park activity row records the from-status (#202)', async () => {
    h.taskRows = [{ status: STATUS.inReview, ownerId: 'u1' }];
    await parkRound('task-1', 'verdict-less review — re-dispatch exhausted');
    expect(h.activities[0]?.payload.fromStatus).toBe(STATUS.inReview);
    expect(h.activities[0]?.payload.reviewParked).toBe(true);
  });

  it('a GATING auto-block from an in-review origin parks with the BLOCK origin (#419)', async () => {
    // the task already sits in a child-derived block: its failure arms must be able to
    // park, and the persisted origin must be the round's home (pre_block_status), never
    // the blocked id — a BLOCKED origin would restore the task into the paused category
    h.taskRows = [
      {
        status: STATUS.blocked,
        ownerId: 'u1',
        rearmAttempts: 0,
        parkFromStatus: null,
        preBlockStatus: STATUS.inReview,
      },
    ];
    const parked = await parkRound('task-1', 'review turn failed — run settled FAILED', { rearmable: true });
    expect(parked).toBe(true);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.set.parkFromStatus).toBe(STATUS.inReview);
    // the park supersedes a stale block origin (#419): both machine origins on one row
    // would make the park discriminator lie
    expect(h.updates[0]?.set.preBlockStatus).toBeNull();
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(1);
    expect(h.updates[0]?.hasPredicate).toBe(true);
    // PARK-ONCE (#419): in the block branch the status term alone cannot arbitrate two
    // concurrent parks (read id == written id) — the unwritten park memory is the guard
    const rendered = mockDb()
      .select()
      .from(dbTasks)
      .where(h.updates[0]?.cond as never)
      .toSQL();
    const flat = rendered.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('"tasks"."park_from_status" is null');
    expect(rendered.params).toEqual(['task-1', STATUS.blocked]);
  });

  it('a GATING auto-block from a NON-review origin never parks (#419)', async () => {
    h.taskRows = [
      { status: STATUS.blocked, ownerId: 'u1', rearmAttempts: 0, parkFromStatus: null, preBlockStatus: 'st-working' },
    ];
    expect(await parkRound('task-1', 'review turn timed out — reaped after 45 min')).toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('a PARK already standing (park_from_status set) is never re-parked (#199/#419)', async () => {
    h.taskRows = [
      {
        status: STATUS.blocked,
        ownerId: 'u1',
        rearmAttempts: 1,
        parkFromStatus: STATUS.inReview,
        // both origins set: the park term alone must refuse (a null pre-block would be
        // rejected by the older origin guard instead — a vacuous pin)
        preBlockStatus: STATUS.inReview,
      },
    ];
    expect(await parkRound('task-1', 'review turn timed out — reaped after 45 min')).toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('a custom IN-REVIEW-category status parks too (#336) — park origin + predicate pin the status read', async () => {
    h.taskRows = [{ status: 'st-custom-review', ownerId: 'u1' }];
    await parkRound('task-1', 'review turn timed out — reaped after 45 min');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.set.parkFromStatus).toBe('st-custom-review');
    expect(h.updates[0]?.hasPredicate).toBe(true);
    // the predicate PINS the status this call read — rendering it is the whole
    // point: reverting to the seeded constant must fail here, not only in prod
    const rendered = mockDb()
      .select()
      .from(dbTasks)
      .where(h.updates[0]?.cond as never)
      .toSQL();
    expect(rendered.params).toEqual(['task-1', 'st-custom-review']);
    expect(h.activities[0]?.payload.fromStatus).toBe('st-custom-review');
  });
});
