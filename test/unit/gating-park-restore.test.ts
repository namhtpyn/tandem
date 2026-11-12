// PARK-ORIGIN RESTORE (#202): a review park persists its own origin (park_from_status),
// and refreshParentGating's unblock arm fires for a parked task too — restoring the
// recorded pre-park status (never the to-do demotion, which would re-enter the
// ready-category dispatch scan and bypass the open review round), clearing both memory
// columns, and replaying the parked reviewer's turn. A plain gated unblock keeps the
// #88 restore law untouched, and the block arm never records BLOCKED as pre-block state.
// GUARDED GATING WRITE (#208): both flips are single conditional writes — the restore
// atomic on the row still being BLOCKED, the auto-block on it not being blocked yet —
// each .returning() as the sole race arbiter against a concurrent owner move; a 0-row
// result means the concurrent writer owns the outcome (no activity note, no turn replay,
// walk stops). The mock below honors that contract: the write lands ONLY when the
// returning arbiter returns rows, and hooks fire inside the real interleave windows
// (statusCategoryMap for the unblock arm, the children read for the block arm).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  taskRows: new Map<string, Record<string, unknown>>(),
  childrenByParent: new Map<string, Array<{ status: string }>>(),
  statusRows: [] as Array<{ id: string; category: string }>,
  updates: [] as Array<{ set: Record<string, unknown>; hasPredicate: boolean }>,
  writeLog: [] as Array<{ set: Record<string, unknown>; cond: unknown; hasPredicate: boolean; applied: boolean }>,
  readCols: [] as Array<Record<string, unknown>>,
  replayed: [] as string[],
  settled: [] as string[],
  answerHealed: [] as string[],
  answerSignature: true,
  roundLive: true,
  lossPlan: [] as boolean[],
  onStatusMapQuery: null as null | (() => void),
  onChildrenQuery: null as null | (() => void),
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
            then: (onFulfilled: (v: Array<{ id: string; category: string }>) => unknown) => {
              // one-shot interleave hook: fires inside the statusCategoryMap await —
              // the exact window a concurrent owner move can land in (#208)
              const run = () => {
                const hook = h.onStatusMapQuery;
                h.onStatusMapQuery = null;
                hook?.();
                return h.statusRows;
              };
              return Promise.resolve().then(run).then(onFulfilled);
            },
            where: async () => terminalRows(),
          };
          return q;
        },
      }),
      query: {
        tasks: {
          findFirst: async (args: { where: { id: { eq: string } }; columns?: Record<string, unknown> }) => {
            if (args.columns) h.readCols.push(args.columns);
            return h.taskRows.get(args.where.id.eq) ?? null;
          },
          findMany: async (args: { where: { parentTaskId: { eq: string } } }) => {
            // one-shot interleave hook: fires at the children read — the block arm's
            // read→write window (#208)
            const hook = h.onChildrenQuery;
            h.onChildrenQuery = null;
            hook?.();
            return h.childrenByParent.get(args.where.parentTaskId.eq) ?? [];
          },
        },
      },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            // the guarded write: rows come back ONLY when the predicate matched —
            // a lost race writes nothing (applied=false never reaches h.updates)
            returning: async () => {
              const lost = h.lossPlan.shift() === true;
              const applied = !lost;
              if (table === tasks) h.writeLog.push({ set, cond, hasPredicate: cond != null, applied });
              if (table === tasks && applied) h.updates.push({ set, hasPredicate: cond != null });
              return applied ? [{ id: 'applied' }] : [];
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
    // #365: a restored round replays only when it is LIVE; an extinguished one settles
    openRoundLive: async () => h.roundLive,
    settleExtinguishedRound: async (taskId: string) => {
      h.settled.push(taskId);
      return true;
    },
    dispatchAiReviewTurns: async (taskId: string) => {
      h.replayed.push(taskId);
    },
    // #369: a restore into the question flow re-runs the answer arm — ONLY on the
    // machine signature (a NULL-holder PENDING ANSWER row); a legal manual move never
    hasOrphanAnswerSignature: async () => h.answerSignature,
    returnRemovedAnswerHolderTask: async (taskId: string) => {
      h.answerHealed.push(taskId);
      return false;
    },
  };
});

import { refreshParentGating, resolveParkRestoreTarget } from '../../server/domains/tasks/gating.service';
import { mockDb, tasks as dbTasks } from './helpers/mock-db';

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
    // the persisted park CLASS marker (#419): a ladder-owned park carries a scheduled
    // re-arm; a decision park and a final (exhausted) park carry none
    parkRearmAttempts: 1,
    parkRearmAfter: new Date('2026-11-11T00:00:00Z'),
    parentTaskId: null,
    ...over,
  });
}

beforeEach(() => {
  h.taskRows.clear();
  h.childrenByParent.clear();
  h.statusRows = SEED_STATUSES;
  h.updates = [];
  h.writeLog = [];
  h.readCols = [];
  h.replayed = [];
  h.settled = [];
  h.answerHealed = [];
  h.roundLive = true;
  h.lossPlan = [];
  h.onStatusMapQuery = null;
  h.onChildrenQuery = null;
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

  it('a DECISION-class park is NOT dissolved by a child landing (#419): the owner resumes it', async () => {
    // a stopped turn / exhausted escalation parks with no scheduled rung — an automatic
    // restore must neither erase the park nor re-dispatch a turn the owner stopped; the
    // row stays blocked so the owner's unblock-resume is the single resume
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 0, parkRearmAfter: null });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0); // no restore, no park memory wiped
    expect(h.replayed).toEqual([]);
    expect(h.settled).toEqual([]);
  });

  it('an EXTINGUISHED decision park is withheld too — the owner resolves it (#419)', async () => {
    // no live voter (the reviewer was deleted) does not make an automatic restore the
    // owner: dissolving the park would settle a round the owner deliberately parked
    h.roundLive = false;
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 0, parkRearmAfter: null });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0);
    expect(h.settled).toEqual([]);
    expect(h.replayed).toEqual([]);
  });

  it('a FINAL (exhausted-ladder) park is not dissolved by a child landing either (#419)', async () => {
    // attempts = ladder length + 1 with no scheduled rung: the ladder deliberately gave
    // up and the watchdog alerts the exhausted shape — a child landing must not revive it
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 5, parkRearmAfter: null });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0);
    expect(h.replayed).toEqual([]);
  });

  it('a machine-parked ANCESTOR restored by the walk re-fires its turn (#419: the ancestor read carries the class)', async () => {
    row('c', { status: STATUS.doing, parentTaskId: 'p' });
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parkRearmAttempts: 1 });
    h.childrenByParent.set('c', [{ status: STATUS.done }]);
    h.childrenByParent.set('p', [{ status: STATUS.done }]); // c itself is terminal after its children
    await refreshParentGating('c');
    expect(h.replayed).toEqual(['p']);
    // BOTH reads (the task and the ancestor) must carry the class marker — a drop on
    // either one silently downgrades that row's park to decision-class
    expect(h.readCols.filter((c) => c.parkRearmAfter === true)).toHaveLength(2);
  });

  it('a restored parked round whose reviewer was deleted settles instead of replaying (#365)', async () => {
    h.roundLive = false;
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview); // the restore itself is unchanged
    expect(h.settled).toEqual(['p']); // the extinguished round is handed to the matrix
    expect(h.replayed).toEqual([]); // never a re-fire of a reviewer who does not exist
  });

  it('a GATING-ONLY restore (pre_block_status, no park) to in-review with no live round settles too (#365)', async () => {
    h.roundLive = false;
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview);
    expect(h.settled).toEqual(['p']);
  });

  it('a restore into the QUESTION flow re-runs the answer arm (#369)', async () => {
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.waitingAnswer });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.waitingAnswer);
    expect(h.answerHealed).toEqual(['p']);
  });

  it('a restore WITHOUT the orphan signature never runs the answer arm (#369)', async () => {
    // a legal manual move into a waiting-answer status carries no NULL-holder row —
    // running the arm there would flip the task back out of the flow its owner chose
    h.answerSignature = false;
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.waitingAnswer });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.updates[0]?.set.status).toBe(STATUS.waitingAnswer);
    expect(h.answerHealed).toEqual([]);
  });

  it('a parked task with children still open is left alone (no unblock, no block-arm rewrite)', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0);
    expect(h.replayed).toEqual([]);
  });

  it('a task carrying a STALE pre-block origin re-blocks with its OWN status as the home (#419)', async () => {
    // a flip out of a block writes only the status, so a non-BLOCKED row can carry a
    // stale pre_block_status — promoting it would restore the task to a category it no
    // longer belongs to (a closed round would land back in-review)
    row('p', { status: STATUS.todo, preBlockStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.todo }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.preBlockStatus).toBe(STATUS.todo);
  });

  it('a TERMINAL settle that still owns an open child re-blocks from its OWN settled status (#423)', async () => {
    // the settle flip exhausts the origins, so the re-gate it triggers must derive the
    // block from the status the flip just wrote — a done task whose child is still open
    // is blocked again with `done` as its recorded home (never the pre-flip in-review id)
    row('p', { status: STATUS.done });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
    expect(h.updates[0]?.set.preBlockStatus).toBe(STATUS.done);
  });

  it('the ancestor walk releases a blocked parent only for a TERMINAL landing (#423)', async () => {
    // the settled status is what the walk reads: a returned-to-todo child keeps its
    // parent's open count — only a terminal landing lowers it and releases the gate
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.todo });
    row('c', { status: STATUS.todo, parentTaskId: 'p' });
    h.childrenByParent.set('p', [{ status: STATUS.todo }]);
    h.childrenByParent.set('c', []);
    await refreshParentGating('c');
    expect(h.updates).toHaveLength(0); // non-terminal landing: nothing released
    h.taskRows.set('c', { ...h.taskRows.get('c'), status: STATUS.done });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('c');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.todo); // the recorded home restores
  });

  it('a WITHHELD decision park still lets the walk re-derive its ancestors (#419)', async () => {
    // 'withheld' is not a lost race: the parked row stays blocked and counts as an open
    // child, so its parent must be re-gated in the same walk
    row('c', {
      status: STATUS.blocked,
      parkFromStatus: STATUS.inReview,
      parkRearmAttempts: 0,
      parkRearmAfter: null,
      parentTaskId: 'p',
    });
    row('p', { status: STATUS.inReview });
    h.childrenByParent.set('c', [{ status: STATUS.done }]); // c's own children terminal
    h.childrenByParent.set('p', [{ status: STATUS.blocked }]); // c is still open
    await refreshParentGating('c');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked); // the parent re-derives
    expect(h.replayed).toEqual([]);
  });

  it('a working task carrying a STALE park origin blocks with its OWN status as the home (#419)', async () => {
    // the settle-matrix flip leaves the stale origin behind; promoting it here would
    // record a home for a round that is not live (the restore would land in-review and
    // the rework would never be dispatched)
    row('p', { status: STATUS.doing, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.todo }]);
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.set.preBlockStatus).toBe(STATUS.doing);
    expect(h.updates[0]?.set.parkFromStatus).toBeNull();
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
    // the gate SUPERSEDES the stale park memory (#419): both machine origins on one row
    // would make the park discriminator (park_from_status IS NULL) lie
    expect(h.updates[0]?.set.parkFromStatus).toBeNull();
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

describe('GUARDED GATING WRITE (#208)', () => {
  it('the unblock restore carries the atomic still-BLOCKED predicate + returning arbiter', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    expect(h.writeLog).toHaveLength(1);
    expect(h.writeLog[0]?.hasPredicate).toBe(true);
    expect(h.updates[0]?.set.status).toBe(STATUS.inReview);
  });

  it('the restore predicate is PARK-AWARE (#419): a park landing in the window must win', async () => {
    // the block-branch park writes while the status stays BLOCKED, so the still-BLOCKED
    // term alone cannot arbitrate it between the restore's read and write
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    const parkedSql = mockDb()
      .select()
      .from(dbTasks)
      .where(h.writeLog[0]?.cond as never)
      .toSQL();
    expect(parkedSql.sql.replace(/\s+/g, ' ').toLowerCase()).toContain('"tasks"."park_from_status" =');
    expect(parkedSql.params).toContain(STATUS.inReview);
  });

  it('a gated (non-parked) restore requires NO park to have appeared (#419)', async () => {
    row('p', { status: STATUS.blocked, preBlockStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    await refreshParentGating('p');
    const gatedSql = mockDb()
      .select()
      .from(dbTasks)
      .where(h.writeLog[0]?.cond as never)
      .toSQL();
    expect(gatedSql.sql.replace(/\s+/g, ' ').toLowerCase()).toContain('"tasks"."park_from_status" is null');
  });

  it('a concurrent owner settle inside the status-map window owns the outcome: no restore, no replay, walk stops', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview, parentTaskId: 'g' });
    row('g', { status: STATUS.blocked, preBlockStatus: STATUS.todo });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    h.childrenByParent.set('g', [{ status: STATUS.done }]); // g would unblock too — only the WINNER may touch it
    h.onStatusMapQuery = () => {
      // owner's tasks.setStatus lands mid-window: cancelled is terminal, park memory cleared
      const cur = h.taskRows.get('p')!;
      h.taskRows.set('p', { ...cur, status: STATUS.cancelled, parkFromStatus: null });
      h.lossPlan = [true]; // the guarded restore misses: the row is no longer BLOCKED
    };
    await refreshParentGating('p');
    expect(h.writeLog).toHaveLength(1); // the walk STOPPED — the ancestor was never touched
    expect(h.updates).toHaveLength(0); // no stale write landed
    expect(h.replayed).toEqual([]); // no turn minted over a settled task
    expect(h.taskRows.get('p')?.status).toBe(STATUS.cancelled); // the owner's verdict stands
  });

  it('a concurrent owner unblock-resume is the only turn source on a lost restore (no double mint)', async () => {
    row('p', { status: STATUS.blocked, parkFromStatus: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.done }]);
    h.onStatusMapQuery = () => {
      // owner's setStatus(in-review) lands mid-window and mints its own replay turn
      const cur = h.taskRows.get('p')!;
      h.taskRows.set('p', { ...cur, status: STATUS.inReview, parkFromStatus: null });
      h.lossPlan = [true];
    };
    await refreshParentGating('p');
    expect(h.replayed).toEqual([]); // the arm adds no second dispatchAiReviewTurns
  });

  it('the auto-block write carries the not-yet-BLOCKED predicate (shape pin)', async () => {
    row('p', { status: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    await refreshParentGating('p');
    expect(h.writeLog).toHaveLength(1);
    expect(h.writeLog[0]?.hasPredicate).toBe(true);
    expect(h.updates[0]?.set.status).toBe(STATUS.blocked);
  });

  it('a park winning the block-arm race keeps its park-origin memory — no stomp', async () => {
    row('p', { status: STATUS.inReview });
    h.childrenByParent.set('p', [{ status: STATUS.doing }]);
    h.onChildrenQuery = () => {
      // parkRound won between the reads and the write: BLOCKED + park origin set
      const cur = h.taskRows.get('p')!;
      h.taskRows.set('p', { ...cur, status: STATUS.blocked, parkFromStatus: STATUS.inReview });
      h.lossPlan = [true]; // ne(BLOCKED) predicate misses
    };
    await refreshParentGating('p');
    expect(h.updates).toHaveLength(0); // no auto-block write landed over the park
    expect(h.taskRows.get('p')?.parkFromStatus).toBe(STATUS.inReview); // origin survives
  });
});
