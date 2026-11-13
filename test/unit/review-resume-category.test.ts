// UNBLOCK-RESUME (CATEGORY-GATE LAW, SPEC #336): a manual owner move back into an
// in-review-CATEGORY status with a live round re-dispatches the parked reviewer.
// The seeded-id version silently skipped a custom in-review target — the owner's
// unblock parked nothing back to life and the round wedged with a PENDING row and
// no run (no probe shape catches it: the wedge arm requires zero PENDING rows).
// REQUEUE HEAL (#440): the same move over a round that CANNOT decide — a decided
// round, or no round at all — opens a FRESH round on the stored roster (zero live
// reviewers completes exactly as submit's zero-reviewer arm does — open-subtasks
// gate included), keeping the owner's chosen status id; a void round still
// settles by the matrix (#365); the post-flip window is submit-isolated and the
// heal is fault-isolated.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_KIND, CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';

// helpers the hoisted mock factories need — vi.hoisted runs before the mocks
const { canonicalStoredUuid, whereVals } = vi.hoisted(() => {
  // faithful copy of review.service.canonicalStoredUuid (the module is mocked, so
  // the heal's skip-note arithmetic must run the REAL shape/case rules)
  const canonicalStoredUuid = (value: string): string | null => {
    const hex = value
      .trim()
      .replace(/^\{|\}$/g, '')
      .replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
    const l = hex.toLowerCase();
    return `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`;
  };
  // the CAS where predicate is drizzle SQL — collect its bound values (columns render
  // at build time); operator-only strings drop out so pins see [id, status, stampISO]
  const whereVals = (w: unknown): unknown[] => {
    if (w == null) return ['<no-where>']; // a deleted .where must FAIL the pin
    const vals: unknown[] = [];
    const walk = (n: unknown) => {
      if (n == null || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (Array.isArray(o.queryChunks)) return void (o.queryChunks as unknown[]).forEach(walk);
      if ('value' in o) {
        const v = o.value;
        if (typeof v !== 'string' || !/^[()=\sa-z_]+$/.test(v)) vals.push(v);
      }
    };
    walk(w);
    return vals;
  };
  return { canonicalStoredUuid, whereVals };
});

const h = vi.hoisted(() => ({
  statuses: [] as Array<{ id: string; category: string }>,
  task: null as null | { id: string; status: string; updatedAt: Date; reviewers: string[] },
  live: false,
  dispatched: [] as string[],
  dispatchThrows: false,
  gateThrows: false,
  settled: [] as string[],
  settleResult: false,
  settleThrows: false,
  discarded: [] as string[],
  liveIds: [] as string[],
  childrenOpen: false,
  warns: [] as string[],
  liveQueue: [] as boolean[],
  priorBrief: '',
  opened: [] as Array<{
    taskId: string;
    reviewers: string[];
    body: string;
    flip: { status: string; updatedAt: Date };
    targetStatus?: string;
  }>,
  openResult: { flipped: false, round: 0, opened: 0, dropped: [] as string[] },
  openThrows: false,
  torndown: [] as Array<[string, string]>,
  gated: [] as string[],
  parked: [] as Array<[string, string, { rearmable?: boolean } | undefined]>,
  noted: [] as Array<[string, string, string | null, string, Record<string, unknown>]>,
  doneFlip: [] as Array<Record<string, unknown>>,
  doneWhere: [] as unknown[][],
  doneRows: [{ id: 'task-1' }] as Array<{ id: string }>,
}));

// (canonicalStoredUuid + whereVals live in the vi.hoisted block above — the mock
// factories reference them before the module body runs)

vi.mock('consola', () => ({
  consola: { withTag: () => ({ warn: (...a: unknown[]) => void h.warns.push(a.map(String).join(' ')) }) },
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      // honor the caller's predicate (DB-mock predicate law): a mis-wired where
      // must FAIL the test, never be masked by an unfiltered mock
      taskStatuses: {
        findMany: async (args?: { where?: { id?: { eq?: string } } }) => {
          const id = args?.where?.id?.eq;
          return id ? h.statuses.filter((s) => s.id === id) : h.statuses;
        },
      },
      tasks: {
        findFirst: async (args?: { where?: { id?: { eq?: string } } }) => {
          if (!h.task) return null;
          const id = args?.where?.id?.eq;
          return id && h.task.id !== id ? null : h.task;
        },
      },
    },
    update: (_table: unknown) => ({
      set: (payload: Record<string, unknown>) => ({
        where: (w: unknown) => ({
          returning: async () => {
            h.doneFlip.push(payload);
            h.doneWhere.push(whereVals(w));
            return h.doneRows;
          },
        }),
      }),
    }),
  },
}));

vi.mock('../../server/domains/tasks/review.service', () => ({
  openRoundLive: async () => (h.liveQueue.length > 0 ? (h.liveQueue.shift() as boolean) : h.live),
  roundResultBody: async () => h.priorBrief,
  dispatchAiReviewTurns: async (taskId: string) => {
    if (h.dispatchThrows) throw new Error('dispatch boom');
    void h.dispatched.push(taskId);
  },
  // #365: a not-live landing is offered to the extinguished-round settle (it no-ops
  // on round-0 / decided rounds — the void-row discriminator lives in the service)
  settleExtinguishedRound: async (taskId: string) => {
    h.settled.push(taskId);
    if (h.settleThrows) throw new Error('settle boom');
    return h.settleResult;
  },
  // #365 r5: an owner reopen discards the stale void rows so later heals never
  // auto-settle the reopen
  discardVoidRows: async (taskId: string) => void h.discarded.push(taskId),
  // #440 heal deps: existence re-check + the round-open + the zero-survivor teardown
  canonicalStoredUuid,
  liveReviewers: async (reviewers: string[]) => {
    const shaped = [...new Set(reviewers.map((id) => canonicalStoredUuid(id)).filter((x) => x !== null))] as string[];
    return shaped.filter((id) => h.liveIds.includes(id));
  },
  openReviewRound: async (
    taskId: string,
    reviewers: string[],
    body: string,
    flip: { status: string; updatedAt: Date },
    targetStatus?: string,
  ) => {
    h.opened.push({ taskId, reviewers, body, flip, targetStatus });
    if (h.openThrows) throw new Error('round-open boom');
    return h.openResult;
  },
  teardownAllPendingRounds: async (taskId: string, reason: string) => void h.torndown.push([taskId, reason]),
  logActivity: async (
    taskId: string,
    kind: string,
    authorId: string | null,
    body: string,
    meta: Record<string, unknown>,
  ) => void h.noted.push([taskId, kind, authorId, body, meta]),
  parkRound: async (taskId: string, why: string, opts?: { rearmable?: boolean }) =>
    void h.parked.push([taskId, why, opts]),
}));

vi.mock('../../server/domains/tasks/gating.service', () => ({
  refreshParentGating: async (taskId: string) => {
    if (h.gateThrows) throw new Error('gating boom');
    void h.gated.push(taskId);
  },
  hasOpenChildren: async () => h.childrenOpen,
}));

import { resumeRoundAfterManualMove } from '../../server/domains/tasks/review-resume';

const T0 = new Date('2026-11-13T00:00:00Z');
// uuid-shaped reviewer ids — the faithful liveReviewers mock (like the real one)
// drops non-uuid junk, so the pins must carry honest rosters
const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UGONE = '99999999-8888-4777-8666-555555555555';

beforeEach(() => {
  h.statuses = [];
  h.task = null;
  h.live = false;
  h.dispatched = [];
  h.dispatchThrows = false;
  h.gateThrows = false;
  h.settled = [];
  h.settleResult = false;
  h.settleThrows = false;
  h.discarded = [];
  h.liveIds = [];
  h.childrenOpen = false;
  h.warns = [];
  h.liveQueue = [];
  h.priorBrief = '';
  h.opened = [];
  h.openResult = { flipped: false, round: 0, opened: 0, dropped: [] };
  h.openThrows = false;
  h.torndown = [];
  h.gated = [];
  h.parked = [];
  h.noted = [];
  h.doneFlip = [];
  h.doneWhere = [];
  h.doneRows = [{ id: 'task-1' }];
});

describe('unblock-resume keys off the target status CATEGORY (#336)', () => {
  it('a custom IN-REVIEW-category target with a live round re-fires the reviewer', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('the seeded in-review status still re-fires (no regression)', async () => {
    h.statuses = [{ id: 'seeded-review', category: CATEGORY.IN_REVIEW }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'seeded-review')).toBe(true);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('a WORKING-category target never re-fires a reviewer — the owner resolved it', async () => {
    h.statuses = [{ id: 'st-custom-doing', category: CATEGORY.WORKING }];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-doing')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('an in-review target with NO live round dispatches nothing — the extinguished-round settle gets the call', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.settled).toEqual(['task-1']);
  });

  it('reopening a SETTLED task (done -> in-review) is never auto-settled (#365 r4)', async () => {
    h.statuses = [
      { id: 'st-done', category: CATEGORY.DONE },
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
    ];
    h.live = false;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review', 'st-done')).toBe(false);
    expect(h.settled).toEqual([]);
    expect(h.discarded).toEqual(['task-1']); // the stale signature is voided too
  });

  it('a reopen over a LIVE round still re-fires the reviewer — and discards the void rows first', async () => {
    h.statuses = [
      { id: 'st-done', category: CATEGORY.DONE },
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
    ];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review', 'st-done')).toBe(false);
    expect(h.discarded).toEqual(['task-1']);
    expect(h.dispatched).toEqual(['task-1']); // the residual live turn keeps its re-fire
    expect(h.opened).toHaveLength(0); // no heal — the round is live
  });

  it('a dangling target status id is dead input — no dispatch, no guess', async () => {
    h.statuses = [];
    h.live = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-legacy-dangling')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe('requeue heal — a move into review over a round that cannot decide (#440)', () => {
  it('a DECIDED round requeued into review heals — fresh round on the stored roster, owner status kept', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = false; // decided round: the settle no-ops by design
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1, U2] };
    h.liveIds = [U1, U2];
    h.openResult = { flipped: true, round: 2, opened: 2, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.opened).toEqual([
      {
        taskId: 'task-1',
        reviewers: [U1, U2],
        body: '',
        flip: { status: 'st-custom-review', updatedAt: T0 },
        targetStatus: 'st-custom-review', // the OWNER'S chosen id, never the seeded one
      },
    ]);
    expect(h.dispatched).toEqual(['task-1']); // the reviewer turn rides the won flip
    expect(h.gated).toEqual(['task-1']); // parent gating first, dispatch second
    expect(h.doneFlip).toHaveLength(0); // no completion write raced the round
  });

  it('a NEVER-REVIEWED task (round 0) requeued into review heals the same way', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openResult = { flipped: true, round: 1, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.body).toBe(''); // round 0: no prior brief to carry
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('the heal re-verifies the landing category — a concurrent move to a working status bails it', async () => {
    h.statuses = [
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
      { id: 'st-working', category: CATEGORY.WORKING },
    ];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-working', updatedAt: T0, reviewers: [U1] }; // moved again mid-heal
    h.liveIds = [U1];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
  });

  it('the reopen door (done -> in-review) heals over a decided round too', async () => {
    h.statuses = [
      { id: 'st-done', category: CATEGORY.DONE },
      { id: 'st-custom-review', category: CATEGORY.IN_REVIEW },
    ];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review', 'st-done')).toBe(true);
    expect(h.discarded).toEqual(['task-1']); // void rows still discarded first
    expect(h.settled).toEqual([]); // and the reopen is still never auto-settled
    expect(h.opened).toHaveLength(1);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('an EMPTY roster completes exactly as if no reviewer were set — no round, no dispatch', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toEqual([{ status: STATUS.done, updatedAt: expect.any(Date) }]);
    // the CAS is pinned for real: id + the owner's status + the stamp the heal read
    expect(h.doneWhere).toEqual([['task-1', 'st-custom-review', T0]]);
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
    expect(h.gated).toEqual(['task-1']);
  });

  it('a roster of only ABSENT reviewers completes the same way and notes the skips', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [UGONE] };
    h.liveIds = []; // the user no longer exists
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(1);
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
    expect(h.noted).toEqual([
      ['task-1', ACTIVITY_KIND.NOTE, null, '1 reviewer(s) skipped — not in the company', { skippedReviewers: 1 }],
    ]);
  });

  it('CASE variants of one id are the same reviewer — never counted as skips (UUID-CASE LAW)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    const id36 = '1b6d1f4e9c2a4d5f8e7a3b6c9d0e1f2a'; // 32 hex chars
    const upper = id36.toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
    const lower = `${id36.slice(0, 8)}-${id36.slice(8, 12)}-${id36.slice(12, 16)}-${id36.slice(16, 20)}-${id36.slice(20)}`;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [lower, upper] };
    h.liveIds = [lower]; // ONE user, two case spellings on the roster
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    // the round opened for ONE canonical reviewer, zero dropped, zero skips
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.reviewers).toEqual([lower]);
    expect(h.noted).toHaveLength(0);
  });

  it('OPEN SUBTASKS hold the WHOLE heal — no completion, no fresh round, a note says why', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.childrenOpen = true; // submit refuses open-subtask parents — the heal holds identically
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.doneFlip).toHaveLength(0); // no completion write
    expect(h.torndown).toHaveLength(0);
    expect(h.noted).toHaveLength(1);
    expect(h.noted[0]?.[3]).toContain('review cannot start');
    expect(h.noted[0]?.[3]).toContain('open subtasks');
  });

  it('open subtasks hold the ROUND-OPEN arm too — live reviewers never mint over them', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = false; // decided round — the heal fires, but the hold preempts it
    h.childrenOpen = true;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
    expect(h.noted).toHaveLength(1);
  });

  it('a VOID round still settles by the matrix — the heal never preempts it (#365)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = true; // void pending row: the matrix settles (done/cancel/todo)
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.settled).toEqual(['task-1']);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0); // the settle owned the outcome, not the heal
  });

  it('a settle FAILURE never heals — the void discriminator owns that shape', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleThrows = true;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
  });

  it('a lost flip arbitration is a quiet no-op — a concurrent writer owns the outcome', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openResult = { flipped: false, round: 2, opened: 1, dropped: [] }; // CAS missed
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
    expect(h.torndown).toHaveLength(0);
  });

  it('the #364 window — every reviewer vanished inside the round-open tx completes the task', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openResult = { flipped: false, round: 0, opened: 0, dropped: [U1] }; // nothing minted, nothing flipped
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(1); // completed exactly as if none were set
    expect(h.torndown).toEqual([['task-1', 'no live reviewers']]);
    expect(h.noted).toEqual([
      ['task-1', ACTIVITY_KIND.NOTE, null, '1 reviewer(s) skipped — not in the company', { skippedReviewers: 1 }],
    ]);
  });

  it('the post-flip window is submit-isolated — a re-gate failure never skips the reviewer turn', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.gateThrows = true;
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true); // round is the outcome
    expect(h.opened).toHaveLength(1); // flip + rows committed
    expect(h.dispatched).toEqual(['task-1']); // the dispatch STILL ran
  });

  it('a dispatch failure parks rearmable — a live round is never left with no run and no marker', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.dispatchThrows = true;
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.parked).toEqual([['task-1', expect.stringContaining('dispatch failed'), { rearmable: true }]]);
    expect(h.dispatched).toHaveLength(0);
  });

  it('a failed heal never fails the owner\u2019s move — fault isolation', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openThrows = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false); // no throw
    expect(h.dispatched).toHaveLength(0);
    expect(h.parked).toHaveLength(0); // nothing committed, nothing to park over
  });

  it('a SPENT ESCALATION TOMBSTONE never blocks the heal — decided rows and tombstones heal (#440 r4)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false; // no PENDING row: the escalated row is a terminal non-vote tombstone
    h.settleResult = false; // the settle no-ops — no void signature to settle
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.priorBrief = 'the original submission';
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    // the fresh round judges the SAME brief the decided round judged — never an empty one
    expect(h.opened).toEqual([
      {
        taskId: 'task-1',
        reviewers: [U1],
        body: 'the original submission',
        flip: { status: 'st-custom-review', updatedAt: T0 },
        targetStatus: 'st-custom-review',
      },
    ]);
    expect(h.dispatched).toEqual(['task-1']);
  });

  it('a live round minted mid-heal (a racing move) is never stacked — the heal re-checks first', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.liveQueue = [false, true]; // first read: not live (enters the heal); re-check: live
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  it('the fresh round notes absent roster ids exactly as submit does (#361 r4)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.settleResult = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1, UGONE] };
    h.liveIds = [U1];
    h.openResult = { flipped: true, round: 2, opened: 1, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.noted).toEqual([
      ['task-1', ACTIVITY_KIND.NOTE, null, '1 reviewer(s) skipped — not in the company', { skippedReviewers: 1 }],
    ]);
    expect(h.dispatched).toEqual(['task-1']); // the note never delays the turn
  });

  it('a failed heal logs through the fault-isolation catch (the quiet guard stays quiet)', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers: [U1] };
    h.liveIds = [U1];
    h.openThrows = true;
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.warns.length).toBeGreaterThanOrEqual(1); // the catch IS the logging path
  });

  it('a task that vanished mid-heal is a quiet no-op', async () => {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = null; // deleted between the move and the heal
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.doneFlip).toHaveLength(0);
    expect(h.warns).toEqual([]); // the vanished-task GUARD answers before any throw/catch
  });
});
