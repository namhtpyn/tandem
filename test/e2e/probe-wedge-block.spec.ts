import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the dead-round wedge arm covers BOTH
// review-flow-owned shapes (#424): an in_review task with a closed round whose newest
// verdict outruns the task's last write, AND a PAUSED gating auto-block whose recorded
// origin resolves to in_review and whose CURRENT round is closed (no PENDING row in
// max(round), at least one verdict row). The detector is pinned by the SQL that ships:
// the probe emits it (--strand-sql) and this spec executes exactly those bytes against
// the e2e database — no test-side copy of the query.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

test.describe('prod probe wedge arm (#424)', () => {
  test('fires on a decided round inside a gating block, silent on every legal shape', async () => {
    const emitted = await $`bash ${script} --strand-sql 2.78.20 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'wedge'");
    expect(strandSql).toContain('park_from_status is null');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      // a PENDING row only counts as a live round when it NAMES a reviewer (the #365 void
      // row is not live) — anchor live controls on the boot admin, which survives resets
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for a live-reviewer seed').not.toBe('');

      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const illegal = `probe-wedge-block-${crypto.randomUUID()}`; // fires: block, then a killing verdict
      const legalRequeue = `probe-wedge-requeue-${crypto.randomUUID()}`; // legal: verdict predates the block
      const liveBlock = `probe-wedge-live-${crypto.randomUUID()}`; // legal: PENDING row in the round
      const parked = `probe-wedge-park-${crypto.randomUUID()}`; // out of scope: a park clears its gate origin (#431)
      const parkedStaleOrigin = `probe-wedge-park-origin-${crypto.randomUUID()}`; // defensive: a park outranks a gate origin
      const manualBlock = `probe-wedge-manual-${crypto.randomUUID()}`; // legal: hand-made block, no origins
      const todoOrigin = `probe-wedge-todo-${crypto.randomUUID()}`; // legal: origin resolves to ready
      const tornDown = `probe-wedge-void-${crypto.randomUUID()}`; // legal: no verdict row in the round
      const suspendedVoid = `probe-wedge-voidrow-${crypto.randomUUID()}`; // legal: a void row suspends the round
      const nonPausedStale = `probe-wedge-stale-${crypto.randomUUID()}`; // legal: stale origin on a non-paused row
      const inReviewOlderPending = `probe-wedge-ir-old-${crypto.randomUUID()}`; // fires: older round PENDING, current decided
      const olderPending = `probe-wedge-oldpending-${crypto.randomUUID()}`; // fires: older round PENDING, current round decided
      const inReviewWedge = `probe-wedge-ir-${crypto.randomUUID()}`; // fires: in_review branch
      const inReviewManual = `probe-wedge-irm-${crypto.randomUUID()}`; // legal: verdict older than write
      const inReviewLive = `probe-wedge-irl-${crypto.randomUUID()}`; // legal: the in_review round is live
      const inReviewVoid = `probe-wedge-irv-${crypto.randomUUID()}`; // legal: a void row suspends the in_review round
      const inReviewOldVerdict = `probe-wedge-iro-${crypto.randomUUID()}`; // defensive: a stale verdict in an old round

      // task write age (minutes ago) per seed; the wedge needs the verdict NEWER than it
      const seedTasks: Array<{ id: string; status: string; pre: string | null; park: string | null; written: number }> =
        [
          { id: illegal, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          // a legal re-queue into an in-review status over an ALREADY-DECIDED round: the
          // verdict predates the move, and a child opening later records that home as a
          // block. The write-vs-verdict discriminator is the only clause that keeps this
          // healthy task out of the arm (r1 review: without it the arm cries wolf).
          { id: legalRequeue, status: BLOCKED, pre: IN_REVIEW, park: null, written: 1 },
          { id: liveBlock, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: parked, status: BLOCKED, pre: null, park: IN_REVIEW, written: 5 },
          // DEFENSIVE, not a legal-shape control: no live writer emits both origins
          // (parkRound and the gate write each clear the other). The clause is kept so a
          // park-owned row can never be read as a block; this seed is its only pin.
          { id: parkedStaleOrigin, status: BLOCKED, pre: IN_REVIEW, park: IN_REVIEW, written: 5 },
          { id: manualBlock, status: BLOCKED, pre: null, park: null, written: 5 },
          { id: todoOrigin, status: BLOCKED, pre: TODO, park: null, written: 5 },
          { id: tornDown, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: suspendedVoid, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: nonPausedStale, status: DOING, pre: IN_REVIEW, park: null, written: 5 },
          { id: inReviewOlderPending, status: IN_REVIEW, pre: null, park: null, written: 10 },
          { id: olderPending, status: BLOCKED, pre: IN_REVIEW, park: null, written: 10 },
          { id: inReviewWedge, status: IN_REVIEW, pre: null, park: null, written: 5 },
          { id: inReviewManual, status: IN_REVIEW, pre: null, park: null, written: 1 },
          { id: inReviewLive, status: IN_REVIEW, pre: null, park: null, written: 5 },
          { id: inReviewVoid, status: IN_REVIEW, pre: null, park: null, written: 5 },
          { id: inReviewOldVerdict, status: IN_REVIEW, pre: null, park: null, written: 5 },
        ];
      for (const t of seedTasks) {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, now(), now() - ($6::int * interval '1 minute'))`,
          [t.id, t.id, t.status, t.pre, t.park, t.written],
        );
      }

      // decidedMinutesAgo = null seeds a still-PENDING row; createdMinutesAgo places the
      // round's rows relative to the task's last write (a teardown lands AFTER its block)
      const seedReview = async (
        taskId: string,
        status: string,
        decidedMinutesAgo: number | null,
        createdMinutesAgo = 10,
        round = 1,
        reviewerId: string | null = null,
      ) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, $6, $3, $7, now() - ($5::int * interval '1 minute'),
                   case when $4::int is null then null else now() - ($4::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, status, decidedMinutesAgo, createdMinutesAgo, round, reviewerId],
        );
      };
      await seedReview(illegal, 'APPROVED', 1);
      await seedReview(legalRequeue, 'APPROVED', 10);
      await seedReview(liveBlock, 'APPROVED', 1);
      await seedReview(liveBlock, 'PENDING', null, 1, 1, adminId);
      await seedReview(parked, 'APPROVED', 1);
      await seedReview(parkedStaleOrigin, 'APPROVED', 1);
      await seedReview(manualBlock, 'APPROVED', 1);
      await seedReview(todoOrigin, 'APPROVED', 1);
      // torn down INSIDE the block (rows newer than the block write): the round holds no
      // verdict row, so it is not a decided round — only the verdict status list sees that
      await seedReview(tornDown, 'SUPERSEDED', null, 1);
      await seedReview(tornDown, 'ESCALATED', null, 1);
      // a round suspended by the #365 void row: a removed reviewer's row still PENDING in
      // the current round means the block's own restore will settle it when it lifts
      await seedReview(suspendedVoid, 'APPROVED', 1);
      await seedReview(suspendedVoid, 'PENDING', null, 1);
      // a stale gate origin left on a non-paused row (#427 egress) is not a block at all
      await seedReview(nonPausedStale, 'APPROVED', 1);
      // the in_review half must read the CURRENT round: an older round's PENDING row is debris
      await seedReview(inReviewOlderPending, 'PENDING', null, 15, 1, adminId);
      await seedReview(inReviewOlderPending, 'APPROVED', 1, 10, 2);
      // the CURRENT round is decided; a PENDING row in an OLDER round must not hide it
      // round 1 is debris from before the round-2 open (created 15 min ago), round 2 was
      // opened at the task's last write (10 min ago) and decided 1 min ago
      await seedReview(olderPending, 'PENDING', null, 15, 1, adminId);
      await seedReview(olderPending, 'CHANGE_REQUESTED', 1, 10, 2);
      await seedReview(inReviewWedge, 'CHANGE_REQUESTED', 1);
      await seedReview(inReviewManual, 'APPROVED', 10);
      await seedReview(inReviewLive, 'APPROVED', 1, 10, 1, null);
      await seedReview(inReviewLive, 'PENDING', null, 1, 1, adminId);
      await seedReview(inReviewVoid, 'APPROVED', 1);
      await seedReview(inReviewVoid, 'PENDING', null, 1);
      // DEFENSIVE (reachable only through the stale-verdict race): the current round has
      // no verdict, so an older round's late verdict must not stand in for it
      await seedReview(inReviewOldVerdict, 'APPROVED', 1, 15, 1);
      await seedReview(inReviewOldVerdict, 'SUPERSEDED', null, 1, 2);

      const rows = await sql.unsafe(strandSql);
      // union columns are unnamed: key on the arm's own label column, never on aliases
      const wedge = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'wedge');
      expect(wedge, 'the emitted SQL must carry the wedge arm').toBeTruthy();
      const fired = new Set(String(wedge?.[1] ?? 'none').split(','));

      expect(fired, 'a gating block recording an in-review home with a closed decided round is the wedge').toContain(
        illegal,
      );
      expect(fired, 'the in_review branch keeps detecting its own shape').toContain(inReviewWedge);
      expect(fired, 'a live block still holds a PENDING row — not a wedge').not.toContain(liveBlock);
      expect(
        fired,
        'a block over an already-decided round (verdict older than the block write) is legal',
      ).not.toContain(legalRequeue);
      expect(fired, 'a park writes no gate origin — it matches neither branch (#431 declares the gap)').not.toContain(
        parked,
      );
      expect(fired, 'a void row keeps the current round suspended — the block restore settles it').not.toContain(
        suspendedVoid,
      );
      expect(fired, 'a stale gate origin on a non-paused row is not a gating block').not.toContain(nonPausedStale);
      expect(fired, 'the in_review half reads the current round: an older round PENDING row is debris').toContain(
        inReviewOlderPending,
      );
      expect(fired, 'a PENDING row in an older round must not hide a decided current round').toContain(olderPending);
      expect(
        fired,
        'DEFENSIVE TERM: no live writer emits both origins — the park term keeps a park-owned row out if one ever does',
      ).not.toContain(parkedStaleOrigin);
      expect(fired, 'a hand-made block clears both origins — legal').not.toContain(manualBlock);
      expect(fired, 'a block whose origin resolves to a non-review status is not the review flow').not.toContain(
        todoOrigin,
      );
      expect(fired, 'a torn-down round holds no verdict row — not a decided round').not.toContain(tornDown);
      expect(fired, 'a verdict older than the task write is a legal manual move').not.toContain(inReviewManual);
      expect(fired, 'the in_review half holds a live round while a reviewer row is PENDING').not.toContain(
        inReviewLive,
      );
      expect(fired, 'a void row suspends the in_review round too — the same current-round clause').not.toContain(
        inReviewVoid,
      );
      expect(fired, 'an older round verdict cannot stand in for the current round').not.toContain(inReviewOldVerdict);
    } finally {
      await sql.close();
    }
  });
});
