// PARK-REARM LAW (#211): an infra-class review park (mint failure, failed/timed-out
// review turn, verdict-settle throw) schedules a bounded re-arm on the backoff ladder —
// the attempt ledger survives the restore, a decision park resets it, and past the
// ladder the round parks FINAL (after = null) for the watchdog. The tick's re-arm scan
// re-runs the unblock arm for due parked rounds whose children are all terminal, and
// defers (no attempt burned) when children are still open.
// Mock routing (drizzle builder conds are opaque objects): selects dispatch on their
// PROJECTION SIGNATURE — the scan's {id}, the kids' {status}, parkRound's
// {ownerId,rearmAttempts,status}, taskStatuses by table — and the kids query rows come
// from a per-test plan (one entry per call, in order). RQB findFirst/findMany args ARE
// plain objects (predicate honored, gating-park-restore precedent).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: new Map<string, Record<string, unknown>>(),
  parkRow: null as Record<string, unknown> | null,
  childrenPlan: [] as Array<Array<{ status: string }>>,
  childrenByParent: new Map<string, Array<{ status: string }>>(),
  statusRows: [] as Array<{ id: string; category: string }>,
  dueRows: [] as Array<{ id: string }>,
  updates: [] as Array<{ set: Record<string, unknown>; hasPredicate: boolean }>,
  dueScanWhereCalls: 0,
  scanLimit: null as number | null,
  activities: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  replayed: [] as string[],
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskStatuses } = await import('../../server/db/schema');
  const projKey = (cols: Record<string, unknown> | undefined) => (cols ? Object.keys(cols).sort().join(',') : '');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const rows = (): Array<Record<string, unknown>> => {
            if (table === taskStatuses) return h.statusRows; // bare await: statusCategoryMap
            const key = projKey(cols);
            if (key === 'id') return h.dueRows as Array<Record<string, unknown>>; // the re-arm scan
            if (key === 'status') return (h.childrenPlan.shift() ?? []) as Array<Record<string, unknown>>;
            if (key === 'ownerId,rearmAttempts,status') return h.parkRow ? [h.parkRow] : [];
            return [];
          };
          // the where-path MUST honor predicates (DB-mock predicate law): the only
          // taskStatuses .where() caller is terminalStatusIds (category in done|cancelled)
          const whereRows = (): Array<Record<string, unknown>> => {
            if (table === taskStatuses)
              return h.statusRows.filter((r) => r.category === 'done' || r.category === 'cancelled');
            return rows();
          };
          const tail = () => ({
            then: <R>(onFulfilled?: (v: Array<Record<string, unknown>>) => R) =>
              Promise.resolve().then(() => onFulfilled?.(whereRows())),
          });
          return {
            then: <R>(onFulfilled?: (v: Array<Record<string, unknown>>) => R) =>
              Promise.resolve().then(() => onFulfilled?.(rows())),
            where: (cond: unknown) => {
              if (projKey(cols) === 'id') h.dueScanWhereCalls += 1;
              void cond;
              return {
                ...tail(),
                orderBy: () => ({
                  limit: (n: number) => {
                    h.scanLimit = n;
                    return tail();
                  },
                }),
              };
            },
          };
        },
      }),
      query: {
        taskStatuses: {
          findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
            const id = args?.where?.id?.eq;
            return id ? h.statusRows.filter((s: { id: string }) => s.id === id) : h.statusRows;
          },
        },
        tasks: {
          findFirst: async (args: { where: { id: { eq: string } } }) => h.taskRows.get(args.where.id.eq) ?? null,
          findMany: async (args: { where: { parentTaskId: { eq: string } } }) =>
            (h.childrenByParent.get(args.where.parentTaskId.eq) ?? []) as Array<Record<string, unknown>>,
        },
      },
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const apply = () => {
              h.updates.push({ set, hasPredicate: cond != null });
              return [{ id: 'applied' }];
            };
            return {
              then: <R>(onFulfilled?: (v: undefined) => R) =>
                Promise.resolve(undefined).then((v) => {
                  apply();
                  return onFulfilled?.(v);
                }),
              returning: async () => apply(),
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

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    logActivity: async () => {},
    // the restored round is LIVE in these specs (a real pending reviewer): dispatch
    openRoundLive: async () => true,
    settleExtinguishedRound: async () => false,
    dispatchAiReviewTurns: async (taskId: string) => {
      h.replayed.push(taskId);
    },
  };
});

import { REARM_SCAN_LIMIT, rearmParkedRounds } from '../../server/domains/tasks/gating.service';
import { PARK_REARM_LADDER_MS, parkRound } from '../../server/domains/tasks/review.service';

const SEED_STATUSES = [
  { id: STATUS.todo, category: 'backlog' },
  { id: STATUS.doing, category: 'working' },
  { id: STATUS.done, category: 'done' },
  { id: STATUS.cancelled, category: 'cancelled' },
  { id: STATUS.inReview, category: 'in_review' },
  { id: STATUS.blocked, category: 'paused' },
];

function row(id: string, over: Record<string, unknown> = {}) {
  h.taskRows.set(id, {
    id,
    status: STATUS.inReview,
    ownerId: 'u1',
    parkRearmAttempts: 0,
    parentTaskId: null,
    ...over,
  });
}

beforeEach(() => {
  h.taskRows.clear();
  h.parkRow = null;
  h.childrenPlan = [];
  h.childrenByParent.clear();
  h.statusRows = SEED_STATUSES;
  h.dueRows = [];
  h.updates = [];
  h.dueScanWhereCalls = 0;
  h.scanLimit = null;
  h.activities = [];
  h.replayed = [];
});

describe('parkRound re-arm ladder (#211)', () => {
  it('a fresh infra park schedules the FIRST re-fire one ladder step out', async () => {
    h.parkRow = { status: STATUS.inReview, ownerId: 'u1', rearmAttempts: 0 };
    await parkRound('t1', 'review turn failed to dispatch — env down', { rearmable: true });
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(1);
    const after = h.updates[0]?.set.parkRearmAfter as Date;
    expect(Math.abs(after.getTime() - Date.now() - PARK_REARM_LADDER_MS[0])).toBeLessThan(5_000);
    expect(h.activities[0]?.payload.rearm).toEqual({ attempt: 1, rearmAfter: after.toISOString() });
  });

  it('a re-fire that fails again climbs the ladder (ledger survives the restore)', async () => {
    h.parkRow = { status: STATUS.inReview, ownerId: 'u1', rearmAttempts: 1 };
    await parkRound('t1', 'review turn failed to dispatch — env still down', { rearmable: true });
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(2);
    const after = h.updates[0]?.set.parkRearmAfter as Date;
    expect(Math.abs(after.getTime() - Date.now() - PARK_REARM_LADDER_MS[1])).toBeLessThan(5_000);
  });

  it('the last in-ladder park schedules the longest step', async () => {
    h.parkRow = { status: STATUS.inReview, ownerId: 'u1', rearmAttempts: 3 };
    await parkRound('t1', 'review turn failed to dispatch — env still down', { rearmable: true });
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(4);
    const after = h.updates[0]?.set.parkRearmAfter as Date;
    expect(Math.abs(after.getTime() - Date.now() - PARK_REARM_LADDER_MS[3])).toBeLessThan(5_000);
  });

  it('past the ladder the round parks FINAL: attempts = length+1, nothing scheduled', async () => {
    h.parkRow = { status: STATUS.inReview, ownerId: 'u1', rearmAttempts: PARK_REARM_LADDER_MS.length };
    await parkRound('t1', 'review turn failed to dispatch — outage outlived the ladder', { rearmable: true });
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(PARK_REARM_LADDER_MS.length + 1);
    expect(h.updates[0]?.set.parkRearmAfter).toBeNull();
    expect(h.activities[0]?.payload.rearm).toEqual({
      attempt: PARK_REARM_LADDER_MS.length + 1,
      rearmAfter: null,
    });
  });

  it('a decision park resets the ledger and schedules nothing (owner resolution only)', async () => {
    h.parkRow = { status: STATUS.inReview, ownerId: 'u1', rearmAttempts: 3 };
    await parkRound('t1', 'review escalation stalled — no eligible supervisor to escalate to');
    expect(h.updates[0]?.set.parkRearmAttempts).toBe(0);
    expect(h.updates[0]?.set.parkRearmAfter).toBeNull();
    expect(h.activities[0]?.payload.rearm).toBeUndefined();
  });
});

describe('rearmParkedRounds tick scan (#211)', () => {
  it('a due parked round with terminal children re-runs the unblock arm: restore + turn re-dispatch', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 1 });
    h.dueRows = [{ id: 'p' }];
    h.childrenPlan = [[{ status: STATUS.done }]]; // kids read: all terminal
    await rearmParkedRounds();
    const restore = h.updates.find((u) => u.set.status === STATUS.inReview);
    expect(restore).toBeTruthy();
    expect(restore?.set.parkFromStatus).toBeNull();
    expect(h.replayed).toEqual(['p']);
    // SQL-side shape: the scan WHEREs + LIMIT-bounds (bounding law)
    expect(h.dueScanWhereCalls).toBe(1);
    expect(h.scanLimit).toBe(REARM_SCAN_LIMIT);
  });

  it('a due round with OPEN children defers one ladder step — no attempt burned, no restore', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 1 });
    h.dueRows = [{ id: 'p' }];
    h.childrenPlan = [[{ status: STATUS.todo }]]; // kids read: one open
    await rearmParkedRounds();
    expect(h.replayed).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBeUndefined();
    expect(h.updates[0]?.set.parkRearmAfter).toBeInstanceOf(Date);
  });

  it('nothing due -> the scan is a silent no-op', async () => {
    h.dueRows = [];
    const n = await rearmParkedRounds();
    expect(n).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.replayed).toEqual([]);
  });

  it('an exhausted ladder (final park, rearm_after null) is never due — the WHERE excludes it', async () => {
    // decision parks and exhausted ladders carry rearm_after NULL: the SQL isNotNull arm
    // never returns them; the unit pins the observable: no due rows -> no writes at all
    row('x', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 5 });
    h.dueRows = [];
    await rearmParkedRounds();
    expect(h.updates).toHaveLength(0);
    expect(h.replayed).toEqual([]);
  });
});
