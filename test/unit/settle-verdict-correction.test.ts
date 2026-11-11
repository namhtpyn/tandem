// VERDICT-LESS BOUND (#276): the settle path's re-dispatch is PER ROUND and binds
// to the SETTLING run's dispatched round — a reviewer returning in a later round
// still gets their corrected retry, a stale settle never touches the live round,
// and the corrected retry is consumed only by a PRIOR COMPLETED (DONE) turn in the
// same round: a reaped/failed turn is not a verdict-less attempt.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  round: 1 as number,
  boundRow: { round: 1, createdAt: new Date('2026-11-03T00:00:00Z') } as { round: number; createdAt: Date } | null,
  seenAt: null as Date | null,
  runs: [] as Array<{ id: string; startedAt: Date | null; status?: string; prompt?: string }>,
  dispatched: [] as Array<Record<string, unknown>>,
  parks: [] as string[],
  parkOpts: [] as Array<Record<string, unknown>>,
  verdictAt: [] as Array<Date | undefined>,
  escalated: 0,
  reviewerExists: true,
  reviewerLookup: null as { where?: { id?: { eq?: string } } } | null,
  resumes: [] as string[],
  drops: [] as Array<[string, string]>,
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskRuns: { findMany: async () => h.runs },
      user: {
        findFirst: async (cfg?: { where?: { id?: { eq?: string } } }) => {
          h.reviewerLookup = cfg ?? null;
          return h.reviewerExists ? { id: 'rev-1' } : null;
        },
      },
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    currentRound: async () => h.round,
    dispatchedReviewRoundRow: async (_taskId: string, _reviewerId: string, at?: Date) => {
      h.seenAt = at ?? null;
      return h.boundRow;
    },
    dispatchAiReviewTurns: async (_taskId: string, _body?: string, opts?: Record<string, unknown>) => {
      h.dispatched.push(opts ?? {});
    },
    recordVerdict: async (
      _taskId: string,
      _reviewerId: string,
      _verdict: string,
      _note: string,
      _source: string,
      at?: Date,
    ) => {
      h.verdictAt.push(at);
      return 'waiting' as const;
    },
    escalateReview: async () => {
      h.escalated += 1;
      return { outcome: 'escalated' as const };
    },
    parkRound: async (_taskId: string, why: string, opts?: Record<string, unknown>) => {
      h.parks.push(why);
      h.parkOpts.push(opts ?? {});
    },
    resumeReviewQueueAfterRemoval: async (taskId: string) => {
      h.resumes.push(taskId);
    },
    dropReviewMintIntent: (taskId: string, reviewerId: string) => {
      h.drops.push([taskId, reviewerId]);
    },
  };
});

import { settleReviewVerdict } from '../../server/domains/tasks/runner.service';

const roundOpen = new Date('2026-11-03T00:00:00Z');
const run = (id: string, at: Date, status = 'DONE', prompt?: string) => ({ id, startedAt: at, status, prompt });
const CORRECTED_BRIEF = 'review brief …\nCORRECTION (verdict-less re-dispatch)\nprevious turn produced no verdict …';
const self = new Date(roundOpen.getTime() + 5000); // the settling run's start

beforeEach(() => {
  h.round = 1;
  h.boundRow = { round: 1, createdAt: roundOpen };
  h.seenAt = null;
  h.runs = [];
  h.dispatched = [];
  h.parks = [];
  h.parkOpts = [];
  h.verdictAt = [];
  h.escalated = 0;
  h.reviewerExists = true;
  h.reviewerLookup = null;
  h.resumes = [];
  h.drops = [];
});

describe('settleReviewVerdict verdict-less bound (#276)', () => {
  it('round 1, first completed turn -> corrected re-dispatch bound to the reviewer', async () => {
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    // the settling run's start drives the round binding (never the latest-run lookup)
    expect(h.seenAt?.getTime()).toBe(self.getTime());
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.verdictCorrection).toBe(true);
    expect(h.dispatched[0]?.verdictlessReviewerId).toBe('rev-1');
    // the SETTLE's round rides the call (#380): without it the lock-loss park would be a
    // silent no-op and the bounded retry would be burned by a plain turn again
    expect(h.dispatched[0]?.round).toBe(1);
  });

  it('a returning reviewer in round 2 with only a PREVIOUS-round turn still gets the corrected retry', async () => {
    // pre-fix defect: lifetime count (round 1 run + round 2 run = 2) parked here
    h.round = 2;
    h.boundRow = { round: 2, createdAt: roundOpen };
    h.runs = [run('old-r1', new Date(roundOpen.getTime() - 86_400_000)), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.round).toBe(2); // the settle's round, not a fixed 1
  });

  it('a PRIOR completed turn this round -> decision park (the corrected retry already failed)', async () => {
    // the SETTLING turn is the correction turn in the #276 shape: its brief carries the block
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000)), run('self', self, 'DONE', CORRECTED_BRIEF)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('finished without a verdict after a re-dispatch');
    // a decision park: no re-arm ladder (a dropped opts arg would silently re-arm it)
    expect(h.parkOpts[0]?.rearmable).toBe(false);
    // the spent retry's parked intent is dropped (#380): a restore must not re-send the block
    expect(h.drops).toEqual([['task-1', 'rev-1']]);
  });

  it('a prior DONE turn minted PLAIN leaves the retry parked — the block was never sent', async () => {
    // the lock-loss half the carry could not reach: dropping here would make the loss
    // permanent, so the intent survives for the restore's re-fire (#380)
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000), 'DONE', 'plain first-turn brief'), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(1);
    expect(h.drops).toEqual([]);
  });

  it('an ECHOED marker mid-line is not a delivery — the intent stays parked', async () => {
    // the brief embeds the result body and verdicts verbatim: a quoted mention must not be
    // read as a dispatched CORRECTION block (that would delete a live, never-sent retry)
    h.runs = [
      run('r1', new Date(roundOpen.getTime() + 1000)),
      run('self', self, 'DONE', 'the reviewer asked about CORRECTION (verdict-less re-dispatch) twice'),
    ];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(1);
    expect(h.drops).toEqual([]);
  });

  it('a DELETED reviewer after its bounded re-dispatch resumes instead of parking (#370)', async () => {
    h.boundRow = { round: 1, createdAt: roundOpen };
    h.reviewerExists = false;
    h.runs = [run('r1', new Date(roundOpen.getTime() + 1000)), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.resumes).toEqual(['task-1']);
  });

  it('a REAPED (failed) turn never consumes the corrected retry', async () => {
    // blind-review r4: only a completed verdict-less turn is a used attempt
    h.runs = [run('reaped', new Date(roundOpen.getTime() + 1000), 'FAILED'), run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(1);
  });

  it('a STALE settle (dispatched round behind current) is a quiet no-op — the live round owns progression', async () => {
    h.round = 2;
    h.boundRow = { round: 1, createdAt: roundOpen };
    h.runs = [run('stale', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(0);
  });

  it('a STALE verdict-carrying settle records NOTHING — no old-round matrix flip (r7)', async () => {
    // r6's `at` pin bound stale verdicts to their own round; without this guard the
    // old round's end-of-round matrix would run and cancel the live round's work
    h.round = 2;
    h.boundRow = { round: 1, createdAt: roundOpen };
    await settleReviewVerdict('task-1', 'rev-1', { kind: 'approved', text: 'ok' } as never, self);
    expect(h.verdictAt).toHaveLength(0);
    expect(h.parks).toHaveLength(0);
  });

  it('a STALE escalate settle rewrites NOTHING on the live roster (r7)', async () => {
    h.round = 2;
    h.boundRow = { round: 1, createdAt: roundOpen };
    await settleReviewVerdict(
      'task-1',
      'rev-1',
      { kind: 'escalate', text: 'escalate to Zed for reviewing' } as never,
      self,
    );
    expect(h.escalated).toBe(0);
    expect(h.parks).toHaveLength(0);
  });

  it('a verdict-carrying settle pins the SAME settling-run start into recordVerdict (r6)', async () => {
    // stale AI verdicts must bind to the round their run was minted for — the
    // recordVerdict path mirrors the verdict-less bound's `at`
    await settleReviewVerdict('task-1', 'rev-1', { kind: 'approved', text: 'ok' } as never, self);
    expect(h.verdictAt).toHaveLength(1);
    expect(h.verdictAt[0]?.getTime()).toBe(self.getTime());
  });

  it('no dispatched round row is an anomaly -> decision park, never a correction dispatch', async () => {
    h.boundRow = null;
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', null, self);
    expect(h.dispatched).toHaveLength(0);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]).toContain('no round row for the reviewer');
  });

  it('a DELETED reviewer with no round row is not an anomaly — the removal owns the round (#370)', async () => {
    // the employee delete nulled the pending row (and the FK); a late turn must
    // never park a round it no longer owns
    h.boundRow = null;
    h.reviewerExists = false;
    h.runs = [run('self', self)];
    await settleReviewVerdict('task-1', 'rev-1', { kind: 'approved', text: 'late' } as never, self);
    // the lookup names THIS reviewer (a missing/wrong predicate would suppress every
    // anomaly park or never skip — DB-mock predicate law)
    expect(h.reviewerLookup?.where?.id?.eq).toBe('rev-1');
    expect(h.parks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.verdictAt).toHaveLength(0);
    // the late settle RESUMES the queue (the departing turn is done; a mint that
    // landed after the removal's capture must not strand the round)
    expect(h.resumes).toEqual(['task-1']);
  });
});
