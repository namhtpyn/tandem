// SUBMIT ROUTES THE CATEGORY DECLINE (#454 r2, CATEGORY-OWNERSHIP AT FLIP): the
// round-open transaction takes the status-mutation advisory mutex as its FIRST
// statement and re-verifies the landing row's category under it — a status row
// re-categorized OUT of in_review inside the verify→flip
// window declines the mint (flipped:false, declined:'category', nothing written).
// Submit must route that decline through its ZERO-REVIEW completion — done,
// teardown of stray rounds, skip note — NOT through the plain CAS-loss throw ('a
// settle owns the outcome'): no settle owns this outcome, an admin re-categorization
// does, and a refused submit would strand a finished run. The route rides the
// pre-existing opened===0 arm (a decline never mints, so opened is 0 by
// construction — vacuity-proven: the route IS that arm; the declined marker is its
// evidence). The plain CAS loss (opened>0, flip lost — a concurrent
// settle/submit/move took the task) keeps its throw.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';
import { isUuid } from '#shared/utils/is-uuid';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  users: [] as Array<{ id: string }>,
  rounds: [] as Array<{ taskId: string; reviewers: string[]; body: string }>,
  openResult: { flipped: true, round: 1, opened: 0, dropped: [] as string[] } as Record<string, unknown>,
  casWins: true,
  teardowns: [] as string[],
  allClosed: [] as string[],
  events: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ vals: Record<string, unknown> }>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskMessages, tasks } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {
        tasks: { findMany: async () => h.taskRows },
        taskStatuses: { findMany: async () => h.statuses },
        user: {
          findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
            const ids = args?.where?.id?.in;
            if (ids?.some((id) => !isUuid(id))) throw new Error('invalid input syntax for type uuid');
            return ids ? h.users.filter((u) => ids.includes(u.id)) : h.users;
          },
        },
      },
      insert: (_table?: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          h.inserts.push({ vals });
          return { returning: async () => [{ id: `msg-${h.inserts.length}` }] };
        },
      }),
      update: (table?: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              h.updates.push(vals);
              if (table === tasks) h.events.push('done-flip');
              return h.casWins ? [{ id: 'task-1' }] : [];
            },
            then: (onF?: (v: unknown) => unknown) => {
              h.updates.push(vals);
              return Promise.resolve([{ id: 'task-1' }]).then(onF);
            },
          }),
        }),
      }),
      select: () => {
        const self: Record<string, unknown> = {};
        self.from = () => self;
        self.where = () => self;
        self.orderBy = () => self;
        self.limit = async () => [];
        self.then = (onF?: (v: unknown) => unknown) => Promise.resolve([]).then(onF);
        return self;
      },
      __taskMessages: taskMessages,
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    spawnObligation: async () => 'obl-1',
    resolveObligation: async () => {},
    cancelObligations: async () => {},
    cancelAllObligations: async () => {},
    answerHolder: async () => null,
  };
});

vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return { ...mod, refreshParentGating: async () => {}, hasOpenChildren: async () => false };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    openRoundLive: async () => false,
    dispatchAiReviewTurns: async () => {},
    openReviewRound: async (taskId: string, reviewers: string[], body: string) => {
      h.rounds.push({ taskId, reviewers, body });
      return { ...h.openResult };
    },
    recordVerdict: async () => ({ outcome: 'superseded' }),
    currentRound: async () => 1,
    teardownOpenRound: async (_t: string, to: string) => {
      h.teardowns.push(to);
      h.events.push(`teardown:${to}`);
    },
    teardownAllPendingRounds: async (_t: string, settledTo: string) => {
      h.allClosed.push(settledTo);
      h.events.push(`closed-all:${settledTo}`);
    },
    settleExtinguishedRound: async (taskId: string) => {
      h.events.push(`extinguished:${taskId}`);
      return false;
    },
  };
});

import { submitResult } from '../../server/domains/tasks/workflow.service';

const LIVE = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const LIVE2 = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function doingTask(reviewers: string[]) {
  return {
    status: 'st-doing',
    assigneeId: 'worker-1',
    ownerId: 'owner-1',
    createdBy: 'owner-1',
    questionChain: [],
    reviewers,
  };
}

beforeEach(() => {
  h.taskRows = [doingTask([LIVE, LIVE2])];
  h.statuses = [{ id: 'st-doing', category: CATEGORY.WORKING }];
  h.users = [{ id: LIVE }, { id: LIVE2 }];
  h.rounds = [];
  h.openResult = { flipped: true, round: 1, opened: 2, dropped: [] };
  h.casWins = true;
  h.teardowns = [];
  h.allClosed = [];
  h.events = [];
  h.updates = [];
  h.inserts = [];
});

describe('submit routes the #454 category decline', () => {
  it('a declined flip completes the task exactly as its zero-reviewer arm does', async () => {
    h.openResult = { flipped: false, round: 0, opened: 0, dropped: [], declined: 'category' };
    const res = await submitResult('task-1', 'worker-1', 'the result');
    expect(res).toEqual({ status: STATUS.done });
    // the zero-review completion ran: the done flip CAS'd on the UNFLIPPED task row
    expect(h.events).toContain('done-flip');
    expect(h.updates.some((u) => u.status === STATUS.done)).toBe(true);
    // the teardown ledger names the REAL reason — not 'no live reviewers' (the
    // roster was live; the review category dissolved)
    expect(h.allClosed).toEqual(['review status left the in_review category']);
    // and the thread says WHY review never started (parity with the heal's note)
    const bodies = h.inserts.map((i) => i.vals.body).filter((b): b is string => typeof b === 'string');
    expect(bodies.join('\n')).toContain('review cannot start — this status is no longer in the review category');
  });

  it('the decline fires with a FULL roster — reviewers are not the reason', async () => {
    h.openResult = { flipped: false, round: 0, opened: 0, dropped: [], declined: 'category' };
    const res = await submitResult('task-1', 'worker-1', 'the result');
    expect(h.rounds).toHaveLength(1);
    expect(h.rounds[0]?.reviewers).toEqual([LIVE, LIVE2]);
    expect(res).toEqual({ status: STATUS.done });
    // the round's OWN completion note never fires for the decline (skipped = 0) —
    // the honest signal is the decline note + the done flip, never a fabricated skip
    const bodies2 = h.inserts.map((i) => i.vals.body).filter((b): b is string => typeof b === 'string');
    expect(bodies2.join('\n')).not.toContain('skipped');
    expect(bodies2.join('\n')).toContain('review cannot start');
  });

  it('a PLAIN flip loss (no declined marker) still throws — a settle owns that outcome', async () => {
    h.openResult = { flipped: false, round: 1, opened: 2, dropped: [] };
    await expect(submitResult('task-1', 'worker-1', 'the result')).rejects.toThrow(
      'task state changed during submit — a settle owns the outcome',
    );
    expect(h.events).not.toContain('done-flip');
    expect(h.allClosed).toEqual([]);
  });
});
