// ESCALATION-HANDOFF HEAL (#474): the referral handoff's writes are separate statements
// (flip, roster, replacement row, obligations, activity). The flip persists the target
// (task_reviews.referral_target_id), so a crash after it leaves an UNREDEEMED referral:
// an ESCALATED row whose recorded target has no row in the round. This spec pins the
// scan's SQL discriminators (status, recorded target, current round, the missing-row
// term, the 60s grace, the #430 owner record) and the pure satisfaction predicate that
// settleRound refuses the matrix on. The live heal and the settle guard execute
// end-to-end in test/e2e/escalation-handoff-heal.spec.ts; the decided-round scan's
// refined referral term is executed in test/e2e/decided-round-heal.spec.ts.
import { describe, expect, it, vi } from 'vitest';

import { REVIEW_STATUS } from '#shared/enums';

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {},
}));

vi.mock('../../server/domains/tasks/thread.service', () => ({ insertActivityMessage: async () => ({ id: 'm' }) }));
vi.mock('../../server/domains/tasks/runner.service', () => ({
  dispatchTask: async () => {},
  replayLostSettle: async () => 'skipped',
}));
vi.mock('../../server/domains/kernel/kernel', () => ({ publishChange: async () => {} }));

const { escalationHandoffScan, referralOwesVote, ESCALATION_HANDOFF_GRACE_MS, ESCALATION_HANDOFF_SCAN_LIMIT } =
  await import('../../server/domains/tasks/review.service');

async function emitted() {
  const { SQL } = await import('bun');
  const { drizzle } = await import('drizzle-orm/bun-sql');
  const client = new SQL('postgresql://probe:***@127.0.0.1:1/probe');
  const cutoff = new Date('2026-11-14T12:00:00Z');
  const query = escalationHandoffScan(drizzle(client as never) as never, cutoff).toSQL();
  return { text: query.sql.toLowerCase(), params: query.params, cutoff };
}

describe('escalationHandoffScan (#474 SQL discriminators)', () => {
  it('selects only unredeemed referrals of the current round', async () => {
    const { text, params, cutoff } = await emitted();
    expect(text).toContain(`"task_reviews"."status" =`);
    expect(params).toContain(REVIEW_STATUS.ESCALATED);
    expect(text).toContain('"task_reviews"."referral_target_id" is not null');
    // a FK-nulled reviewer (user delete) is still a candidate: the recorded target owes
    // the vote and the replay logs a NULL author
    expect(text).not.toContain('"task_reviews"."reviewer_id" is not null');
    // current round only — an old round's escalation can never be re-fired
    expect(text).toContain('select max(r3.round) from task_reviews r3 where r3.task_id = "tasks"."id"');
    expect(text).toContain('"task_reviews"."round" =');
    // the missing-row term: the recorded target has NO row in the round
    expect(text).toContain('not exists (select 1 from task_reviews t2');
    expect(text).toContain('t2.reviewer_id = "task_reviews"."referral_target_id"');
    // the 60s grace rides the scan
    expect(params).toContain(cutoff);
    expect(ESCALATION_HANDOFF_GRACE_MS).toBe(60_000);
  });

  it('keeps a legal manual move out (#430 owner record) and bounds the read', async () => {
    const { text, params } = await emitted();
    expect(text).toContain(`m.body like 'status: %'`);
    expect(text).toContain(`a.payload->>'kind' = 'status'`);
    expect(text).toContain('m.created_at >=');
    expect(params).toContain(ESCALATION_HANDOFF_SCAN_LIMIT);
    expect(text).toContain('order by');
    expect(text).toContain('limit');
  });

  it('pins the taskId re-read filter used at decision time', async () => {
    const { SQL } = await import('bun');
    const { drizzle } = await import('drizzle-orm/bun-sql');
    const client = new SQL('postgresql://probe:***@127.0.0.1:1/probe');
    const query = escalationHandoffScan(drizzle(client as never) as never, new Date(), 'task-1').toSQL();
    expect(query.sql.toLowerCase()).toContain('"tasks"."id" =');
    expect(query.params).toContain('task-1');
  });
});

describe('referralOwesVote (#474 satisfaction predicate)', () => {
  const row = (status: string, reviewerId: string | null, referralTargetId?: string | null) => ({
    status,
    reviewerId,
    referralTargetId,
  });

  it('owes the vote when an escalated row records a target with no row', () => {
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, 'a', 'b')])).toBe(true);
  });

  it('is satisfied once the recorded target has ANY row in the round', () => {
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, 'a', 'b'), row(REVIEW_STATUS.PENDING, 'b')])).toBe(false);
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, 'a', 'b'), row(REVIEW_STATUS.APPROVED, 'b')])).toBe(false);
  });

  it('a tombstone (no recorded target) owes nothing', () => {
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, 'a', null)])).toBe(false);
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, null)])).toBe(false);
  });

  it('a deleted escalator (FK-nulled reviewer) still owes the RECORDED target its vote', () => {
    // the user delete nulls the escalator's reviewer id; the referral's intent survives,
    // so the round still owes the target's vote (the replay logs with a NULL author)
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, null, 'b')])).toBe(true);
    // ... and it is satisfied once that target has a row
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, null, 'b'), row(REVIEW_STATUS.PENDING, 'b')])).toBe(false);
  });

  it('a normal round owes nothing', () => {
    expect(referralOwesVote([row(REVIEW_STATUS.APPROVED, 'a'), row(REVIEW_STATUS.PENDING, 'b')])).toBe(false);
  });

  it('a multi-escalation chain is satisfied link by link', () => {
    // A -> B (B has its tombstone row), then B -> C (C has no row): C is owed
    expect(referralOwesVote([row(REVIEW_STATUS.ESCALATED, 'a', 'b'), row(REVIEW_STATUS.ESCALATED, 'b', 'c')])).toBe(
      true,
    );
    // both targets present -> satisfied
    expect(
      referralOwesVote([
        row(REVIEW_STATUS.ESCALATED, 'a', 'b'),
        row(REVIEW_STATUS.ESCALATED, 'b', 'c'),
        row(REVIEW_STATUS.APPROVED, 'c'),
      ]),
    ).toBe(false);
  });
});
