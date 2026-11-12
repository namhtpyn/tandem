// REVIEW-TURN MINT GATE + OFF-REVIEW SETTLE REFUSAL (#401): a review turn can be
// minted for a task a manual move took out of review, and the end-of-round flip used
// to refuse only done/cancelled- and waiting_answer-category statuses — an all-approved
// settle therefore flipped a manually re-queued todo task to done, overriding the
// owner's move.
//
// The flip's mock ENFORCES the predicate it renders (a mock that returns rows
// regardless would pass every ordering): the flip lands only when the rendered SQL's
// status list contains the row's CURRENT status, so removing the in-review gate turns
// the refusal cases green-but-wrong and fails them here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY, REVIEW_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const h = vi.hoisted(() => ({
  task: { id: 'task-1', status: '', parkFromStatus: null as string | null, preBlockStatus: null as string | null },
  statuses: [] as Array<{ id: string; category: string }>,
  roundRows: [] as Array<Record<string, unknown>>,
  matrixRows: [] as Array<Record<string, unknown>>,
  pendingRows: [] as Array<Record<string, unknown>>,
  aiEmployees: [] as Array<{ userId: string }>,
  /** rendered predicates of every tasks UPDATE, in order */
  flips: [] as Array<{ sql: string; params: unknown[]; set: Record<string, unknown> }>,
  dispatched: [] as Array<Record<string, unknown>>,
  notes: [] as Array<{ body: string; payload: Record<string, unknown> }>,
  cancelledAll: [] as string[],
  published: 0,
  casMiss: false,
  /** taskReviews read counter: [1] the verdict's own row, [2] the settle matrix, [3+] mint rows */
  reviewRead: 0,
  /** #423: parent-gating calls made by a WON flip, with the status already written */
  regated: [] as Array<{ taskId: string; status: string }>,
  regateThrows: false,
  /** #423 clause 6: the best-effort re-gate's LOGGED half */
  warnings: [] as string[],
  /** #423 composition pin: run the REAL gating service for one test */
  realGating: false,
  /** the task's children, read by the real gating walk */
  children: [] as Array<{ status: string }>,
}));

vi.mock('../../server/db/index', async () => {
  const { tasks, taskReviews, taskRuns } = await import('../../server/db/schema');
  const rowsThenable = (resolve: () => Array<Record<string, unknown>>) => {
    const p = () => Promise.resolve(resolve());
    return {
      then: (onF?: (v: Array<Record<string, unknown>>) => unknown, onR?: (e: unknown) => unknown) => p().then(onF, onR),
      catch: (onR: (e: unknown) => unknown) => p().catch(onR),
    };
  };
  const reviewRows = () => {
    h.reviewRead += 1;
    return h.reviewRead === 1 ? h.roundRows : h.reviewRead === 2 ? h.matrixRows : h.pendingRows;
  };
  return {
    asDb: (x: unknown) => x,
    db: {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const resolve = (): Array<Record<string, unknown>> => {
            if (table === tasks && cols && 'status' in cols)
              return [
                { status: h.task.status, parkFromStatus: h.task.parkFromStatus, preBlockStatus: h.task.preBlockStatus },
              ];
            if (table === taskRuns) return []; // no live run on the task
            if (table === taskReviews) {
              if (cols && 'round' in cols) return [{ round: 1 }];
              if (cols && 'resultBody' in cols) return [{ resultBody: 'submitted work' }];
              return reviewRows();
            }
            return [];
          };
          const chain: Record<string, unknown> = {
            where: () => chain,
            innerJoin: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            ...rowsThenable(resolve),
          };
          return chain;
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: { toQuery?: (cfg: unknown) => { sql: string; params: unknown[] } }) => {
            const applied = () => {
              if (table !== tasks) return [{ id: 'row-1' }]; // the verdict CAS
              // drizzle's SQL renders through toQuery (no toSQL in this version)
              const rendered = cond?.toQuery?.({
                escapeName: (n: string) => `"${n}"`,
                escapeParam: (i: number) => `$${i + 1}`,
              }) ?? { sql: '', params: [] };
              h.flips.push({ ...rendered, set });
              // ENFORCE the rendered predicate: the in-review `in (...)` arm must
              // contain the row's CURRENT status, or the machine-blocked arm must
              // match (status = blocked AND a recorded park/pre-block origin). A
              // predicate without either arm allows everything (the un-gated shape).
              const paramsOf = (placeholders: string) =>
                (placeholders.match(/\$(\d+)/g) ?? []).map((t) => rendered.params[Number(t.slice(1)) - 1]);
              // [0] = the in-review arm, [1] = the paused (block) arm
              const statusArms = [...rendered.sql.matchAll(/"tasks"\."status" in \(([^)]*)\)/g)];
              // the carve-out must check the origin VALUE, not merely its presence: the
              // rendered origin lists are what the mock honors
              const parkArm = /"tasks"\."park_from_status" in \(([^)]*)\)/.exec(rendered.sql);
              const preArm = /"tasks"\."pre_block_status" in \(([^)]*)\)/.exec(rendered.sql);
              const machineArm = Boolean(parkArm) || Boolean(preArm);
              const inReviewAllows = statusArms[0] ? paramsOf(statusArms[0][1]!).includes(h.task.status) : false;
              // the two origins are alternatives unless the rendered connector says `and`
              const originBetween =
                parkArm && preArm ? rendered.sql.slice(parkArm.index! + parkArm[0].length, preArm.index) : '';
              const originOr = parkArm && preArm ? /\bor\b/.test(originBetween) : true;
              const parkOk = parkArm ? paramsOf(parkArm[1]!).includes(h.task.parkFromStatus ?? '') : false;
              const preOk = preArm ? paramsOf(preArm[1]!).includes(h.task.preBlockStatus ?? '') : false;
              const machineAllows =
                Boolean(statusArms[1]) &&
                machineArm &&
                paramsOf(statusArms[1]![1]!).includes(h.task.status) &&
                (originOr ? parkOk || preOk : parkOk && preOk);
              const gated = Boolean(statusArms[0]) || machineArm;
              // the TOP-LEVEL connector decides how the two arms compose; an `and` here
              // would refuse every in-review task that is not machine-blocked
              let allowed = true;
              if (gated) {
                const second = statusArms[1];
                if (statusArms[0] && second) {
                  const between = rendered.sql.slice(statusArms[0].index! + statusArms[0][0].length, second.index);
                  allowed = /\bor\b/.test(between) ? inReviewAllows || machineAllows : inReviewAllows && machineAllows;
                } else {
                  allowed = inReviewAllows || machineAllows;
                }
              }
              if (!allowed) return [];
              if (typeof set.status === 'string') h.task.status = set.status;
              return [{ id: h.task.id }];
            };
            return {
              ...rowsThenable(applied),
              returning: async () => applied(),
            };
          },
        }),
      }),
      query: {
        taskStatuses: { findMany: async () => h.statuses },
        aiEmployees: { findMany: async () => h.aiEmployees },
        user: { findMany: async () => [] },
        // the real gating walk's reads (composition pin, #423)
        tasks: {
          findFirst: async (args: { where: { id: { eq: string } } }) =>
            args.where.id.eq === h.task.id
              ? {
                  id: h.task.id,
                  status: h.task.status,
                  preBlockStatus: null,
                  parkFromStatus: null,
                  parkRearmAfter: null,
                  parentTaskId: null,
                }
              : null,
          findMany: async (args: { where: { parentTaskId: { eq: string } } }) =>
            args.where.parentTaskId.eq === h.task.id ? h.children : [],
        },
      },
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    insertActivityMessage: async (args: { body: string; payload: Record<string, unknown> }) => {
      h.notes.push({ body: args.body, payload: args.payload });
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => void (h.published += 1) };
});

vi.mock('../../server/domains/tasks/obligations.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/obligations.service')>();
  return {
    ...mod,
    resolveObligation: async () => {},
    cancelObligations: async () => {},
    cancelAllObligations: async (_t: unknown, role: unknown) => void h.cancelledAll.push(String(role)),
    spawnObligation: async () => {},
    spawnObligationTracked: async () => ({ created: true }),
  };
});

vi.mock('../../server/domains/tasks/runner.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/runner.service')>();
  return {
    ...mod,
    dispatchTask: async (_taskId: string, _url: string, opts?: Record<string, unknown>) => {
      h.dispatched.push(opts ?? {});
      return { runId: 'run-1' };
    },
  };
});

// #423 clause 6: the re-gate's failure path must LOG and not surface. consola's child
// loggers (`consola.withTag(...)`) carry their own warn, so a spy on the root instance
// cannot see the service's lines — mock the module and record every warn.
vi.mock('consola', async (importOriginal) => {
  const mod = await importOriginal<typeof import('consola')>();
  const record = (...args: unknown[]) => void h.warnings.push(args.map((a) => String(a)).join(' '));
  const child = new Proxy({} as Record<string, unknown>, { get: (_t, p) => (p === 'warn' ? record : () => {}) });
  const root = new Proxy({} as Record<string, unknown>, {
    get: (_t, p) => (p === 'withTag' ? () => child : p === 'warn' ? record : () => {}),
  });
  return { ...mod, consola: root, default: root };
});

// #423: the settle flip re-gates through a dynamic import (module graph stays acyclic at
// load time). The mock records the call with the status the flip already wrote, so the
// pin proves gating ran AFTER the write and from the FLIPPED status.
vi.mock('../../server/domains/tasks/gating.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/gating.service')>();
  return {
    ...mod,
    refreshParentGating: async (taskId: string) => {
      if (h.regateThrows) throw new Error('gating read failed');
      h.regated.push({ taskId, status: h.task.status });
      // the composition pin runs the REAL walk against this file's db mock
      if (h.realGating) await mod.refreshParentGating(taskId);
    },
  };
});

import { dispatchAiReviewTurns, recordVerdict } from '../../server/domains/tasks/review.service';

beforeEach(() => {
  h.task = { id: 'task-1', status: STATUS.inReview, parkFromStatus: null, preBlockStatus: null };
  h.statuses = [
    { id: STATUS.todo, category: CATEGORY.READY },
    { id: STATUS.inReview, category: CATEGORY.IN_REVIEW },
    { id: 'st-review-custom', category: CATEGORY.IN_REVIEW },
    { id: STATUS.done, category: CATEGORY.DONE },
    { id: STATUS.cancelled, category: CATEGORY.CANCELLED },
    { id: STATUS.blocked, category: CATEGORY.PAUSED },
    { id: STATUS.waitingAnswer, category: CATEGORY.WAITING_ANSWER },
  ];
  h.roundRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
  h.matrixRows = [{ round: 1, status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' }];
  h.pendingRows = [];
  h.aiEmployees = [{ userId: 'rev-1' }];
  h.flips = [];
  h.dispatched = [];
  h.notes = [];
  h.cancelledAll = [];
  h.published = 0;
  h.casMiss = false;
  h.reviewRead = 0;
  h.regated = [];
  h.regateThrows = false;
  h.warnings = [];
  h.realGating = false;
  h.children = [];
});

describe('off-review settle refusal (#401)', () => {
  it('an all-approved settle never flips a task the owner moved out of review', async () => {
    h.task.status = STATUS.todo;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.todo); // the owner's move stands
    expect(h.notes).toHaveLength(0); // no settle-arm note
    expect(h.published).toBe(0);
    // the flip was ATTEMPTED with the in-review allow-list — the refusal is the write's
    expect(h.flips).toHaveLength(1);
  });

  it('an all-rejected settle never cancels a task the owner moved out of review', async () => {
    h.task.status = STATUS.todo;
    h.matrixRows = [{ round: 1, status: REVIEW_STATUS.REJECTED, reviewerId: 'rev-1' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.REJECTED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.todo);
    expect(h.cancelledAll).toHaveLength(0);
  });

  it('a request_change settle never bounces a task the owner moved out of review', async () => {
    h.task.status = STATUS.todo;
    h.matrixRows = [
      { round: 1, status: REVIEW_STATUS.CHANGE_REQUESTED, reviewerId: 'rev-1' },
      { round: 1, status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-2' },
    ];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.CHANGE_REQUESTED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.todo); // the owner's move stands
  });

  it('the same settle still completes a task that is in review', async () => {
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
    expect(h.published).toBeGreaterThan(0);
  });

  it('a CUSTOM in-review-category status accepts the flip (category, never the seeded id)', async () => {
    h.task.status = 'st-review-custom';
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
  });

  it('still settles a MACHINE-blocked task (gating auto-block: pre_block_status records the in-review home)', async () => {
    // a subtask created under an in-review parent auto-blocks it mid-round (#208); the
    // closing verdict must still settle — the block is not an owner move
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: STATUS.inReview };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
  });

  it('still settles a MACHINE-blocked task (a review park: park_from_status records the origin)', async () => {
    h.task = { ...h.task, status: STATUS.blocked, parkFromStatus: STATUS.inReview };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
  });

  it('a CUSTOM in-review origin still settles the machine block (origin resolved by category)', async () => {
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: 'st-review-custom' };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
  });

  it('refuses a MANUALLY blocked task (no machine origin): the owner move stands', async () => {
    h.task = { ...h.task, status: STATUS.blocked };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.blocked);
  });

  it('refuses a machine block whose recorded origin is NOT an in-review status (a stale pre_block_status)', async () => {
    // gating records whatever status the task held, so a STALE in-review origin must never
    // unlock the flip (the owner's manual move also clears both origins, router-side)
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: STATUS.todo };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.task.status).toBe(STATUS.blocked);
  });

  it('a non-closing verdict on a waiting_answer task leaves the next reviewer unminted (the answer re-fires it)', async () => {
    h.task = { ...h.task, status: STATUS.waitingAnswer };
    h.matrixRows = [
      { round: 1, status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' },
      { round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-2' },
    ];
    h.aiEmployees = [{ userId: 'rev-1' }, { userId: 'rev-2' }];
    h.pendingRows = [{ id: 'row-2', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-2' }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'waiting' });
    expect(h.dispatched).toHaveLength(0); // the mint gate: not in review, no turn
  });

  it('the flip predicate is an in-review ALLOW-list: both in-review statuses, no other status, no deny-list', async () => {
    await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    const flip = h.flips[0];
    expect(flip?.sql).toContain('"tasks"."status" in (');
    expect(flip?.sql).not.toMatch(/\bnot in\b/);
    expect(flip?.params.slice(0, 3)).toEqual(['task-1', STATUS.inReview, 'st-review-custom']);
    expect(flip?.params).toContain(STATUS.blocked); // the paused arm's id (one status in this fixture)
    expect(flip?.sql.match(/"tasks"\."status" in \(/g)).toHaveLength(2); // in-review arm + paused arm
    expect(flip?.params).not.toContain(STATUS.todo);
    expect(flip?.params).not.toContain(STATUS.done);
    // the machine-blocked carve-out is part of the predicate and it checks the origin
    // VALUE (an id in the in-review list), not merely its presence
    expect(flip?.sql).toContain('"tasks"."park_from_status" in (');
    expect(flip?.sql).toContain('"tasks"."pre_block_status" in (');
    // the two origins are alternatives (a park carries park_from_status only, a gating
    // auto-block carries pre_block_status only) — pin the CONNECTOR, not just the arms:
    // an `and` here would refuse the park arm and strand the decided round it saves
    expect(flip?.sql).toMatch(/"tasks"\."park_from_status" in \([^)]*\)\)? or \(?"tasks"\."pre_block_status" in \(/);
  });
});

describe('review-turn mint gate (#401)', () => {
  it('mints nothing for a task that left review', async () => {
    h.task.status = STATUS.todo;
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('mints the next turn while the task is in review', async () => {
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.reviewBy).toBe('rev-1');
  });

  it('mints on a GATING auto-block (child-derived): the correction turn is never dropped', async () => {
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: STATUS.inReview };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
  });

  it('mints nothing for a re-queued task carrying a stale in-review origin (the block landing is what gates)', async () => {
    h.task = { ...h.task, status: STATUS.todo, preBlockStatus: STATUS.inReview };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('mints on a gating block whose origin is a CUSTOM in-review status (resolved by category)', async () => {
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: 'st-review-custom' };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
  });

  it('mints nothing for a gating block whose origin is NOT in review (a stale origin)', async () => {
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: STATUS.todo };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('mints nothing for a parked task (blocked/paused) — the park owns the round', async () => {
    // parkFromStatus set AND a valid in-review pre-block origin: only the PARK term can
    // refuse, so deleting it turns this test red
    h.task = { ...h.task, status: STATUS.blocked, parkFromStatus: STATUS.inReview, preBlockStatus: STATUS.inReview };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('mints nothing while the task waits on an answer', async () => {
    h.task = { ...h.task, status: STATUS.waitingAnswer };
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  it('a CUSTOM in-review-category status mints (category, never the seeded id)', async () => {
    h.task.status = 'st-review-custom';
    h.pendingRows = [{ id: 'row-1', round: 1, status: REVIEW_STATUS.PENDING, reviewerId: 'rev-1' }];
    await expect(dispatchAiReviewTurns('task-1')).resolves.toBe(true);
    expect(h.dispatched).toHaveLength(1);
  });
});

// SETTLE-CLEARS-GATING LAW (#423): the end-of-round flip is where a round's machine
// context ENDS. A decided round that settles out of a child-derived auto-block left
// pre_block_status behind — an illegal shape (a live block has a PENDING row, a park
// carries park_from_status) that every `flow still owns` reader misreads, and whose
// spent park ladder would re-enter the park scan on the task's next block. The same
// write therefore exhausts both origins and the ladder, and a WON flip re-gates from
// the status it just wrote (best-effort: the settle already committed).
describe('settle exhausts the gating context and re-gates (#423)', () => {
  const arms = [
    {
      name: 'all-approved',
      verdict: REVIEW_STATUS.APPROVED,
      matrix: [{ round: 1, status: REVIEW_STATUS.APPROVED, reviewerId: 'rev-1' }],
      target: STATUS.done,
      outcome: 'done',
    },
    {
      name: 'all-rejected',
      verdict: REVIEW_STATUS.REJECTED,
      matrix: [{ round: 1, status: REVIEW_STATUS.REJECTED, reviewerId: 'rev-1' }],
      target: STATUS.cancelled,
      outcome: 'cancelled',
    },
    {
      name: 'request_change',
      verdict: REVIEW_STATUS.CHANGE_REQUESTED,
      matrix: [{ round: 1, status: REVIEW_STATUS.CHANGE_REQUESTED, reviewerId: 'rev-1' }],
      target: STATUS.todo,
      outcome: 'returned',
    },
  ] as const;

  for (const arm of arms) {
    it(`${arm.name}: the winning flip clears both origins and resets the park ladder`, async () => {
      h.matrixRows = [...arm.matrix];
      const outcome = await recordVerdict('task-1', 'rev-1', arm.verdict, '', 'human');
      expect(outcome).toEqual({ outcome: arm.outcome });
      const set = h.flips[0]?.set ?? {};
      expect(set.status).toBe(arm.target);
      // presence AND value: a dropped key leaves undefined, which fails toBeNull here
      expect(set.preBlockStatus).toBeNull();
      expect(set.parkFromStatus).toBeNull();
      expect(set.parkRearmAttempts).toBe(0);
      expect(set.parkRearmAfter).toBeNull();
      // every landing re-gates from ITS OWN target — the request_change arm is the one
      // this law newly covers (the pre-diff code skipped the todo landing), so pinning
      // only the grant arm leaves that arm free to lose its re-gate silently (#426 r1)
      expect(h.regated).toEqual([{ taskId: 'task-1', status: arm.target }]);
    });
  }

  it('the re-gate runs AFTER the flip wrote, from the FLIPPED status', async () => {
    // the mock records h.task.status at call time, so a re-gate that ran before the
    // write (or from the pre-flip status) is visible here as `in_review`
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.regated).toEqual([{ taskId: 'task-1', status: STATUS.done }]);
  });

  it('a flip that loses to an owner move re-gates nothing (the owner propagates gating)', async () => {
    h.task.status = STATUS.todo;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'superseded' });
    expect(h.regated).toHaveLength(0);
  });

  it('a settle out of a child-derived block clears the block origin (the #423 drift shape)', async () => {
    h.task = { ...h.task, status: STATUS.blocked, preBlockStatus: STATUS.inReview };
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const set = h.flips[0]?.set ?? {};
    expect(set.status).toBe(STATUS.done);
    expect(set.preBlockStatus).toBeNull();
    expect(h.regated).toEqual([{ taskId: 'task-1', status: STATUS.done }]);
  });

  it('COMPOSITION: a settle that still owns an open child lands BLOCKED with the settled status as its home (#423)', async () => {
    // every other #423 test stubs gating, so none of them composes the two halves: here
    // the REAL walk runs against this file's db mock, and the block write it produces is
    // the assertion — a settle that never re-gates leaves the task in `done` (red)
    h.realGating = true;
    h.children = [{ status: STATUS.doing }];
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    const blockWrite = h.flips.at(-1)?.set ?? {};
    expect(blockWrite.status).toBe(STATUS.blocked);
    expect(blockWrite.preBlockStatus).toBe(STATUS.done);
  });

  it('a failing re-gate is logged, never surfaced — the committed settle stands', async () => {
    h.regateThrows = true;
    const outcome = await recordVerdict('task-1', 'rev-1', REVIEW_STATUS.APPROVED, '', 'human');
    expect(outcome).toEqual({ outcome: 'done' });
    expect(h.task.status).toBe(STATUS.done);
    expect(h.notes.length).toBeGreaterThan(0); // the settle-arm note still lands
    expect(h.published).toBeGreaterThan(0);
    // clause 6's LOGGED half: a silent `catch {}` must not pass this pin (#426 r1)
    expect(h.warnings.some((w) => w.includes('re-gate after the flip failed'))).toBe(true);
  });
});
