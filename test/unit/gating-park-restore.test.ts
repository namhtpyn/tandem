// PARK-ORIGIN RESTORE (#202): a review park persists its own origin (park_from_status),
// and refreshParentGating's unblock arm fires for a parked task too — restoring the
// recorded pre-park status (never the to-do demotion, which would re-enter the
// ready-category dispatch scan and bypass the open review round), clearing both memory
// columns, and replaying the parked reviewer's turn. A plain gated unblock keeps the
// #88 restore law untouched, and the block arm never records BLOCKED as pre-block state.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: new Map<string, Record<string, unknown>>(),
  childrenByParent: new Map<string, Array<{ status: string }>>(),
  statusRows: [] as Array<{ id: string; category: string }>,
  updates: [] as Array<{ set: Record<string, unknown> }>,
  replayed: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: () => {
          // statusCategoryMap awaits .from() bare (all rows); terminalStatusIds chains
          // .where(category in done|cancelled) — the mock must honor that predicate
          const terminalRows = () => h.statusRows.filter((r) => r.category === 'done' || r.category === 'cancelled');
          const q = {
            then: (onFulfilled: (v: Array<{ id: string; category: string }>) => unknown) =>
              Promise.resolve(h.statusRows).then(onFulfilled),
            where: async () => terminalRows(),
          };
          return q;
        },
      }),
      query: {
        tasks: {
          findFirst: async (args: { where: { id: { eq: string } } }) => h.taskRows.get(args.where.id.eq) ?? null,
          findMany: async (args: { where: { parentTaskId: { eq: string } } }) =>
            h.childrenByParent.get(args.where.parentTaskId.eq) ?? [],
        },
      },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => ({
            then: <R>(onFulfilled?: (v: undefined) => R) => {
              if (table === tasks) h.updates.push({ set });
              return Promise.resolve(undefined).then(() => onFulfilled?.(undefined));
            },
          }),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    logActivity: async () => {},
    dispatchAiReviewTurns: async (taskId: string) => {
      h.replayed.push(taskId);
    },
  };
});

import { refreshParentGating, resolveParkRestoreTarget } from '../../server/domains/tasks/gating.service';

const SEED_STATUSES = [
  { id: STATUS.todo, category: 'backlog' },
  { id: STATUS.doing, category: 'working' },
  { id: STATUS.done, category: 'done' },
  { id: STATUS.cancelled, category: 'cancelled' },
  { id: STATUS.waitingAnswer, category: 'waiting_answer' },
  { id: STATUS.inReview, category: 'in_review' },
  { id: STATUS.blocked, category: 'paused' },
];

function row(id: string, over: Record<string, unknown> = {}) {
  h.taskRows.set(id, {
    id,
    status: STATUS.todo,
    preBlockStatus: null,
    parkFromStatus: null,
    parentTaskId: null,
    ...over,
  });
}

beforeEach(() => {
  h.taskRows.clear();
  h.childrenByParent.clear();
  h.statusRows = SEED_STATUSES;
  h.updates = [];
  h.replayed = [];
});

describe('resolveParkRestoreTarget (#202)', () => {
  it('a known park origin restores itself', () => {
    const known = new Map([[STATUS.inReview, 'in_review']]);
    expect(resolveParkRestoreTarget(STATUS.inReview, known)).toBe(STATUS.inReview);
  });

  it('an unknown/malformed origin falls back to in-review, never to-do', () => {
    expect(resolveParkRestoreTarget('ghost-status', new Map())).toBe(STATUS.inReview);
  });
});

describe('refreshParentGating park-origin unblock (#202)', () => {
  it('parked parent + last child lands terminal -> back to in-review, memory cleared, turn replayed', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview);
    expect(h.updates[0]?.set.preBlockStatus).toBeNull();
    expect(h.updates[0]?.set.parkFromStatus).toBeNull();
    expect(h.replayed).toEqual(['p']);
  });

  it('gated-then-parked (stale pre_block_status) restores the park origin, NEVER to-do', async () => {
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.todo, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview);
    expect(h.updates[0]?.set.preBlockStatus).toBeNull();
    expect(h.updates[0]?.set.parkFromStatus).toBeNull();
  });

  it('unknown park origin id falls back to in-review (no dangling status, no to-do demotion)', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: 'ghost' });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview);
  });

  it('a plain gated unblock keeps the #88 restore law: working demotes to to-do, no replay', async () => {
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.doing });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.todo);
    expect(h.updates[0]?.set.preBlockStatus).toBeNull();
    expect(h.updates[0]?.set.parkFromStatus).toBeNull();
    expect(h.replayed).toEqual([]);
  });

  it('a parked task with children still open is left alone (no unblock, no block-arm rewrite)', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0);
    expect(h.replayed).toEqual([]);
  });

  it('the block arm on a parked-memory row records the park origin as pre-block, never BLOCKED itself', async () => {
    // parked task whose owner moved it back to in-review by a path that kept the memory:
    // new children spawn -> auto-block seeds pre = park origin (in-review), NOT blocked
    row('p', { status: STATUS.inReview, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.set.preBlockStatus).toBe(STATUS.inReview);
  });

  it('the walk continues past a restored parked child and gates the ancestor', async () => {
    row('c', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parentTaskId: 'p' });
    row('p', { status: STATUS.todo });
    h.childrenByParent.set('c', [{ status: STATUS.done }]);
    h.childrenByParent.set('p', [{ status: STATUS.inReview }]); // c post-restore: open again
    await refreshParentGating('c');
    expect(h.updates).toHaveLength(2);
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview); // child restored
    expect(h.updates[1]?.set.status).toBe(STATUS.blocked); // parent re-blocked
    expect(h.updates[1]?.set.preBlockStatus).toBe(STATUS.todo);
    expect(h.replayed).toEqual(['c']);
  });
});
