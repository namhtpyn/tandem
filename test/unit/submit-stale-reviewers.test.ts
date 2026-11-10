// REVIEWER EXISTENCE (#361) — round open: tasks.reviewers is a text[] with no FK,
// so an employee deleted AFTER being set leaves a ghost id that hits
// task_reviews.reviewer_id's FK (23503) at submit and wedges the task in a driver
// 500. submit re-checks the roster: ghosts drop out (with a STATUS note), the
// round opens for the survivors, and zero survivors completes the task exactly as
// if no reviewer were set. Legacy rosters also carry non-uuid junk (22P02 on the
// uuid column) and case variants of one id (round unique-index 23505) — both are
// canonicalized/dropped by the same read.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';
import { isUuid } from '#shared/utils/is-uuid';

const h = vi.hoisted(() => ({
  taskRows: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ id: string; category: string }>,
  users: [] as Array<{ id: string }>,
  rounds: [] as Array<{ taskId: string; reviewers: string[]; body: string }>,
  roundDrops: [] as string[],
  roundLive: false,
  roundError: false,
  casWins: true,
  teardowns: [] as string[],
  allClosed: [] as string[],
  settled: [] as string[],
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
          // predicate-faithful mock: only the ids the WHERE actually names come
          // back, so a candidate set that lost canonicalization fails loudly
          findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
            const ids = args?.where?.id?.in;
            // uuid-column faithful: a non-uuid value bound to user.id raises 22P02
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
      // keep the import referenced so the mock shape stays honest about the schema
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
    openRoundLive: async () => h.roundLive,
    dispatchAiReviewTurns: async () => {},
    openReviewRound: async (taskId: string, reviewers: string[], body: string) => {
      if (h.roundError) throw new Error('insert_fk_miss');
      h.rounds.push({ taskId, reviewers, body });
      return { round: 1, opened: reviewers.length - h.roundDrops.length, dropped: h.roundDrops };
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
    // #365: the in-review flip offers the just-opened round to the extinguished settle
    settleExtinguishedRound: async (taskId: string) => {
      h.settled.push(taskId);
      return false;
    },
  };
});

import { submitResult } from '../../server/domains/tasks/workflow.service';

const GHOST = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
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

/** the thread/activity rows the submit wrote — the skip note must be visible there */
function threadBodies() {
  return h.inserts.map((i) => i.vals.body).filter((b): b is string => typeof b === 'string');
}

/** the activity extension payloads (kind + structured meta) */
function activityPayloads() {
  return h.inserts
    .map((i) => i.vals.payload)
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object');
}

beforeEach(() => {
  h.taskRows = [doingTask([])];
  h.statuses = [{ id: 'st-doing', category: CATEGORY.WORKING }];
  h.users = [{ id: LIVE }, { id: LIVE2 }];
  h.rounds = [];
  h.roundDrops = [];
  h.roundLive = false;
  h.roundError = false;
  h.casWins = true;
  h.teardowns = [];
  h.allClosed = [];
  h.settled = [];
  h.events = [];
  h.updates = [];
  h.inserts = [];
});

describe('submit drops reviewers that no longer name a user (#361)', () => {
  it('a ghost reviewer cannot wedge the submit — the task completes as if no reviewer were set', async () => {
    h.taskRows = [doingTask([GHOST])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.done });
    expect(h.rounds).toHaveLength(0);
    expect(threadBodies().join('\n')).toContain('1 reviewer(s) skipped — not in the company');
  });

  it('a mixed roster opens the round for the survivors only — the ghost never reaches task_reviews', async () => {
    h.taskRows = [doingTask([LIVE, GHOST])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds).toHaveLength(1);
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
    expect(threadBodies().join('\n')).toContain('1 reviewer(s) skipped — not in the company');
  });

  it('a live roster is untouched — the round still opens for EVERY reviewer', async () => {
    h.taskRows = [doingTask([LIVE, LIVE2])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE, LIVE2]);
    expect(threadBodies().join('\n')).not.toContain('skipped');
    // #365: the in-review flip hands the fresh round to the extinguished settle (no-op
    // while live voters exist; it heals a reviewer deleted inside the round-open window)
    expect(h.settled).toEqual(['task-1']);
  });

  it('the existence read is case-insensitive both ways (UUID-CASE LAW) — an uppercase stored id survives', async () => {
    h.taskRows = [doingTask([LIVE.toUpperCase()])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds).toHaveLength(1);
  });

  it('case variants of ONE reviewer collapse to a single canonical id — no round unique-index wedge, no false skip note', async () => {
    h.taskRows = [doingTask([LIVE.toUpperCase(), LIVE])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
    expect(threadBodies().join('\n')).not.toContain('skipped');
  });

  it('a legacy non-uuid roster value is dropped, not bound to the uuid column (22P02 would re-wedge the retry)', async () => {
    h.taskRows = [doingTask(['alice'])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.done });
    expect(h.rounds).toHaveLength(0);
  });

  it('the skip note is a THREAD note (rendered), carrying the skipped count', async () => {
    h.taskRows = [doingTask([GHOST])];
    await submitResult('task-1', 'worker-1', 'done');
    const note = activityPayloads().find((p) => p.kind === 'NOTE');
    expect(note).toMatchObject({ kind: 'NOTE', skippedReviewers: 1 });
  });

  it('two ghosts count as two skips in one note', async () => {
    const ghost2 = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
    h.taskRows = [doingTask([GHOST, ghost2])];
    await submitResult('task-1', 'worker-1', 'done');
    expect(threadBodies().join('\n')).toContain('2 reviewer(s) skipped — not in the company');
  });

  it('survivors keep the stored roster order — never the user-table order', async () => {
    h.taskRows = [doingTask([LIVE2, LIVE])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE2, LIVE]);
  });

  it('a braced legacy spelling that names a live user survives and is canonicalized', async () => {
    h.taskRows = [doingTask([`{${LIVE}}`])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
    expect(threadBodies().join('\n')).not.toContain('skipped');
  });

  it('a hyphenless legacy spelling that names a live user survives and is canonicalized', async () => {
    h.taskRows = [doingTask([LIVE.replaceAll('-', '')])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
    expect(threadBodies().join('\n')).not.toContain('skipped');
  });

  it('one live reviewer stored under two spellings is ONE reviewer — no phantom skip note', async () => {
    h.taskRows = [doingTask([LIVE, `{${LIVE}}`])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
    expect(threadBodies().join('\n')).not.toContain('skipped');
  });

  it('a FAILED round-open writes no skip note — the note never outlives a refused submit', async () => {
    h.roundError = true;
    h.taskRows = [doingTask([LIVE, GHOST])];
    await expect(submitResult('task-1', 'worker-1', 'done')).rejects.toThrow('insert_fk_miss');
    expect(threadBodies().join('\n')).not.toContain('skipped');
  });

  it('a zero-survivor completion closes EVERY pending round (not just the max), AFTER winning the CAS', async () => {
    h.taskRows = [doingTask([GHOST])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.done });
    expect(h.allClosed).toEqual(['no live reviewers']);
    // a lost CAS must never tear down a round the winner owns (#361 r5)
    expect(h.events.indexOf('closed-all:no live reviewers')).toBeGreaterThan(h.events.indexOf('done-flip'));
  });

  it('a lost completion CAS refuses and closes nothing', async () => {
    h.casWins = false;
    h.taskRows = [doingTask([GHOST])];
    await expect(submitResult('task-1', 'worker-1', 'done')).rejects.toThrow(
      'task state changed during submit — a settle owns the outcome',
    );
    expect(h.allClosed).toEqual([]);
  });

  it('a ghost plus junk counts both skips in exactly ONE note', async () => {
    h.taskRows = [doingTask([GHOST, 'alice'])];
    await submitResult('task-1', 'worker-1', 'done');
    const lines = threadBodies().filter((b) => b.includes('reviewer(s) skipped'));
    expect(lines).toEqual(['2 reviewer(s) skipped — not in the company']);
  });

  it('a live reviewer plus non-uuid junk opens the round for the live reviewer only', async () => {
    h.taskRows = [doingTask(['alice', LIVE])];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.inReview });
    expect(h.rounds[0]?.reviewers).toEqual([LIVE]);
  });

  it('every survivor deleted inside the round-open transaction (#364) completes exactly like zero survivors', async () => {
    h.taskRows = [doingTask([LIVE])];
    h.roundDrops = [LIVE];
    const res = await submitResult('task-1', 'worker-1', 'done');
    expect(res).toEqual({ status: STATUS.done });
    // never flipped in-review over a round that minted nothing
    expect(h.settled).toEqual([]);
    expect(h.allClosed).toEqual(['no live reviewers']);
    expect(threadBodies().join('\n')).toContain('1 reviewer(s) skipped — not in the company');
  });
});
