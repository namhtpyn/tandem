// HEAL BOUNDARY OF THE CATEGORY DECLINE (#454, CATEGORY-OWNERSHIP AT FLIP): the
// round-open transaction key-shares the landing status row and re-verifies its
// category - an admin re-categorization serializing BEFORE the flip declines the
// mint (flipped:false, declined:'category'). The requeue heal must BAIL on that
// marker: the owner's landed status stays untouched, NO zero-reviewer completion
// fires (reviewers did not vanish - the category dissolved), no CAS_LOST retry
// spins, and the honest note records why the move's review never started. The
// shape rides the manual-move-out semantics: the next move into any
// in-review-category status resumes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_KIND, CATEGORY } from '#shared/enums';
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
  currentRound: 0,
  pendingRows: [] as Array<{ status: string }>,
  torndownThrows: false,
  parkThrows: false,
  pendingWhere: [] as unknown[][],
  opened: [] as Array<{
    taskId: string;
    reviewers: string[];
    body: string;
    flip: { status: string; updatedAt: Date };
    targetStatus?: string;
  }>,
  openResult: { flipped: false, round: 0, opened: 0, dropped: [] as string[] },
  openResultQueue: [] as Array<{ flipped: boolean; round: number; opened: number; dropped: string[] }>,
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
    select: (_cols: Record<string, unknown>) => ({
      from: (_t: unknown) => ({
        // the REAL chain ends .where(...).limit(1) — mock the whole shape so a
        // chain drift fails loudly instead of falling into the heal's catch-all
        where: (w: unknown) => ({
          limit: async () => {
            h.pendingWhere.push(whereVals(w));
            return h.pendingRows;
          },
        }),
      }),
    }),
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
  currentRound: async () => h.currentRound,
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
    return h.openResultQueue.length > 0 ? (h.openResultQueue.shift() as typeof h.openResult) : h.openResult;
  },
  teardownAllPendingRounds: async (taskId: string, reason: string) => {
    if (h.torndownThrows) throw new Error('teardown boom');
    void h.torndown.push([taskId, reason]);
  },
  logActivity: async (
    taskId: string,
    kind: string,
    authorId: string | null,
    body: string,
    meta: Record<string, unknown>,
  ) => void h.noted.push([taskId, kind, authorId, body, meta]),
  parkRound: async (taskId: string, why: string, opts?: { rearmable?: boolean }) => {
    if (h.parkThrows) throw new Error('park boom');
    void h.parked.push([taskId, why, opts]);
  },
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
  h.currentRound = 0;
  h.pendingRows = [];
  h.torndownThrows = false;
  h.parkThrows = false;
  h.pendingWhere = [];
  h.opened = [];
  h.openResult = { flipped: false, round: 0, opened: 0, dropped: [] };
  h.openResultQueue = [];
  h.openThrows = false;
  h.torndown = [];
  h.gated = [];
  h.parked = [];
  h.noted = [];
  h.doneFlip = [];
  h.doneWhere = [];
  h.doneRows = [{ id: 'task-1' }];
});

describe('requeue heal bails on the #454 category decline', () => {
  const DECLINED = { flipped: false, round: 0, opened: 0, dropped: [], declined: 'category' };

  function seedHeal(reviewers: string[]) {
    h.statuses = [{ id: 'st-custom-review', category: CATEGORY.IN_REVIEW }];
    h.live = false;
    h.task = { id: 'task-1', status: 'st-custom-review', updatedAt: T0, reviewers };
    h.liveIds = [...reviewers];
  }

  const declineNotes = () =>
    h.noted
      .filter(([, kind, , body]) => kind === ACTIVITY_KIND.NOTE)
      .map(([, , , body]) => body)
      .join('\n');

  it('a declined flip bails the heal — owner status kept, no completion, no retry', async () => {
    seedHeal([U1, U2]);
    h.openResult = { ...DECLINED };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    // openReviewRound ran EXACTLY once — the declined arm returns false, the
    // CAS_LOST retry wrapper never fires a second round-open
    expect(h.opened).toHaveLength(1);
    // no zero-reviewer completion: the done flip NEVER ran
    expect(h.doneFlip).toHaveLength(0);
    // the honest note says why the review never started
    expect(declineNotes()).toContain('review cannot start — this status is no longer in the review category');
    // no reviewer turn, no rearm park, no teardown — nothing minted, nothing parked
    expect(h.dispatched).toHaveLength(0);
    expect(h.parked).toHaveLength(0);
    expect(h.torndown).toHaveLength(0);
  });

  it('the declined bail does NOT spin a retry even when every open declines', async () => {
    seedHeal([U1]);
    h.openResultQueue = [{ ...DECLINED }, { ...DECLINED }];
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(false);
    expect(h.opened).toHaveLength(1);
    expect(h.doneFlip).toHaveLength(0);
    expect(declineNotes()).toContain('review cannot start');
  });

  it('a WON flip still heals — the decline arm never over-bails', async () => {
    seedHeal([U1, U2]);
    h.priorBrief = 'the brief';
    h.openResult = { flipped: true, round: 2, opened: 2, dropped: [] };
    expect(await resumeRoundAfterManualMove('task-1', 'st-custom-review')).toBe(true);
    expect(h.dispatched).toEqual(['task-1']);
    expect(h.doneFlip).toHaveLength(0);
    expect(declineNotes()).not.toContain('review cannot start');
  });
});
