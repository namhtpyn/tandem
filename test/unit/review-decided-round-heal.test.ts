// DECIDED-ROUND HEAL (#472): the #467 settle transaction's declared crash boundary —
// a hard process kill inside the transaction rolls back to "task in review, this round
// decided" (verdict CAS committed, no PENDING row left, no flip). Every other healer
// keys on a PENDING row, so the shape was owner-only recovery; the tick now replays the
// END-OF-ROUND MATRIX over the round's own verdict rows.
//
// This spec pins the SHAPE in SQL (the sweep's whole decision rides the scan): the
// current-round verdict row, the no-PENDING clause, the 60s settle grace, and the #430
// owner-record term (a `status: …` body with its 1:1 STATUS payload, newer than the
// round's newest verdict) that keeps a legal manual re-queue out. The live heal and the
// discriminator are executed end-to-end in test/e2e/decided-round-heal.spec.ts.
import { describe, expect, it, vi } from 'vitest';

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

const { decidedRoundScan, staleSettlePin, DECIDED_ROUND_GRACE_MS, DECIDED_ROUND_SCAN_LIMIT } =
  await import('../../server/domains/tasks/review.service');

async function emitted() {
  const { SQL } = await import('bun');
  const { drizzle } = await import('drizzle-orm/bun-sql');
  const client = new SQL('postgresql://probe:***@127.0.0.1:1/probe');
  const cutoff = new Date('2026-11-14T12:00:00Z');
  const query = decidedRoundScan(drizzle(client as never) as never, cutoff).toSQL();
  return { text: query.sql.toLowerCase(), params: query.params, cutoff };
}

describe('decidedRoundScan (#472 SQL discriminators)', () => {
  it('scans the CURRENT round verdict row of a review-flow-owned task', async () => {
    const { text, params } = await emitted();
    expect(text).toContain('select max(r3.round)');
    expect(text).toContain('"task_reviews"."round" =');
    // the ownership disjunction: in_review, or a paused gating block from an in-review origin
    expect(params).toEqual(expect.arrayContaining(['in_review', 'paused']));
    expect(text).toContain('park_from_status" is null');
    expect(text).toContain('pre_block_status');
  });

  it('requires a verdict row and the round-newest stamp', async () => {
    const { text } = await emitted();
    expect(text).toContain('"task_reviews"."status" in');
    expect(text).toContain("in ('approved', 'change_requested', 'rejected')");
    expect(text).toContain('max(coalesce(r4.decided_at, r4.created_at))');
    expect(text).toContain('coalesce("task_reviews"."decided_at", "task_reviews"."created_at") <');
  });

  it('carries the no-PENDING clause and the 60s grace cutoff', async () => {
    const { text, params, cutoff } = await emitted();
    expect(text).toContain("p.status = 'pending'");
    expect(text).toContain('p.round =');
    // the cutoff is a parameter on the same coalesced stamp the newest-verdict term uses
    const hasCutoff = params.some((p) =>
      p instanceof Date ? p.getTime() === cutoff.getTime() : String(p) === cutoff.toISOString(),
    );
    expect(hasCutoff).toBe(true);
    expect(params).toContain(DECIDED_ROUND_SCAN_LIMIT);
    expect(DECIDED_ROUND_GRACE_MS).toBe(60_000);
    expect(DECIDED_ROUND_SCAN_LIMIT).toBe(20);
  });

  it('carries the #430 owner-record term: `status: ` body + STATUS payload newer than the verdict', async () => {
    const { text } = await emitted();
    expect(text).toContain("m.body like 'status: %'");
    expect(text).toContain("a.payload->>'kind' = 'status'");
    expect(text).toContain('m.created_at >');
    expect(text).toContain('task_message_activities');
  });

  it('projects the task stamp the replay flip is pinned to', async () => {
    const { text } = await emitted();
    expect(text).toContain('"tasks"."updated_at"');
  });

  it('renders the #292-r2 stale-settle pin at millisecond precision, and none without a pin', async () => {
    const { SQL } = await import('bun');
    const { drizzle } = await import('drizzle-orm/bun-sql');
    const { tasks } = await import('../../server/db/schema');
    const client = new SQL('postgresql://probe:***@127.0.0.1:1/probe');
    const d = drizzle(client as never) as never as {
      select: (p: unknown) => {
        from: (t: unknown) => { where: (w: unknown) => { toSQL: () => { sql: string; params: unknown[] } } };
      };
    };
    const at = new Date('2026-11-14T12:00:00.123Z');
    const q = d
      .select({ id: tasks.id })
      .from(tasks)
      .where(staleSettlePin({ updatedAt: at }))
      .toSQL();
    expect(q.sql.toLowerCase()).toContain("date_trunc('milliseconds'");
    expect(q.params.some((p) => p instanceof Date && p.getTime() === at.getTime())).toBe(true);
    // the status term closes the same-millisecond window: a legal manual move always lands
    // on a different status id (a self-edge is refused).
    const q2 = d
      .select({ id: tasks.id })
      .from(tasks)
      .where(staleSettlePin({ updatedAt: at, status: 'st-in-review' }))
      .toSQL();
    expect(q2.sql.toLowerCase()).toContain('"tasks"."status" =');
    expect(q2.params).toContain('st-in-review');
    expect(staleSettlePin()).toBeUndefined();
  });

  it('never treats a round carrying a referral as decided (#472 r6, refined #474)', async () => {
    const { text } = await emitted();
    expect(text).toContain("e.status = 'escalated'");
    expect(text).toContain('e.round = ' + '"task_reviews"."round"');
    // #474: the block keys on the RECORDED target's missing row — a tombstone (no
    // recorded target) or a satisfied referral never blocks the heal
    expect(text).toContain('e.referral_target_id is not null');
    expect(text).toContain('not exists (select 1 from task_reviews t2');
    expect(text).toContain('t2.reviewer_id = e.referral_target_id');
  });

  it('excludes an owner record written in the same instant (conservative direction)', async () => {
    const { text } = await emitted();
    expect(text).toContain('m.created_at >=');
  });

  it('scopes a re-read to one task when pinned (the decision-time re-check)', async () => {
    const { SQL } = await import('bun');
    const { drizzle } = await import('drizzle-orm/bun-sql');
    const client = new SQL('postgresql://probe:***@127.0.0.1:1/probe');
    const wide = decidedRoundScan(drizzle(client as never) as never, new Date('2026-11-14T12:00:00Z')).toSQL();
    const pinned = decidedRoundScan(
      drizzle(client as never) as never,
      new Date('2026-11-14T12:00:00Z'),
      '00000000-0000-7000-8000-00000000b472',
    ).toSQL();
    expect(pinned.sql.toLowerCase()).toContain('"tasks"."id" =');
    expect(pinned.params).toContain('00000000-0000-7000-8000-00000000b472');
    expect(wide.params).not.toContain('00000000-0000-7000-8000-00000000b472');
  });
});
