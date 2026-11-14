import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the dead-round wedge arm covers BOTH
// review-flow-owned shapes (#424): an in_review task with a closed decided round, AND a
// PAUSED gating auto-block whose recorded origin resolves to in_review and whose CURRENT
// round is closed (no PENDING row in max(round), at least one verdict row). The
// manual-freedom discriminator is the ABSENCE of an OWNER status write newer than the
// round's newest verdict (#430): tasks.setStatus is the only writer of a `status: …`
// activity body, so a legal re-queue over an already-decided round always carries its
// move newer than the verdict while a machine restore (the child landing) or a
// title/assignee edit after the verdict cannot mask a lost settle flip.
// The detector is pinned by the SQL that ships: the probe emits it (--strand-sql) and
// this spec executes exactly those bytes against the e2e database — no test-side copy of
// the query.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

test.describe('prod probe wedge arm (#424)', () => {
  test('fires on a decided round inside a gating block, silent on every legal shape', async () => {
    const emitted = await $`bash ${script} --strand-sql 2.78.24 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'wedge'");
    expect(strandSql).toContain('park_from_status is null');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      // ANY PENDING row in the current round suppresses the arm (a void row included), so
      // a live-round control names a real reviewer; the boot admin survives resets
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
      const maskedRestore = `probe-wedge-restored-${crypto.randomUUID()}`; // fires: block → verdict → child-restore, no owner move
      const maskedBlock = `probe-wedge-maskedblk-${crypto.randomUUID()}`; // fires: block → verdict → title edit, no owner move
      const restoredRequeue = `probe-wedge-restoredreq-${crypto.randomUUID()}`; // legal: the owner re-queue predates the block/restore
      const noteDecoy = `probe-wedge-notedecoy-${crypto.randomUUID()}`; // fires: a NOTE body starting `status: ` must not mask
      const deletedMoverRequeue = `probe-wedge-deletedmover-${crypto.randomUUID()}`; // legal: the mover's user row is gone (author NULL)
      const staleVerdictRequeue = `probe-wedge-staleverdict-${crypto.randomUUID()}`; // legal: owner move after the CURRENT round's verdict
      const staleMoveWedge = `probe-wedge-stalemove-${crypto.randomUUID()}`; // fires: the only owner move PREDATES the round's verdict (#438)

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
          // #430 masks, on purpose: the task row was written AFTER the killing verdict (a
          // child-restore landing back in review / a title edit), which is exactly what the
          // retired updated_at ordering could not see — no owner move follows the verdict
          { id: maskedRestore, status: IN_REVIEW, pre: null, park: null, written: 1 },
          { id: maskedBlock, status: BLOCKED, pre: IN_REVIEW, park: null, written: 1 },
          // the legal twin of maskedRestore: the owner's re-queue explicitly PREDATES the
          // block, so the machine block/restore that follows is a legal state, not a wedge
          { id: restoredRequeue, status: IN_REVIEW, pre: null, park: null, written: 10 },
          // a NOTE whose body starts `status: ` must not silence the wedge, a deleted
          // mover's authored move still counts, and an older round's late verdict must not
          // stand in for the current round's when deciding whether the owner moved last
          { id: noteDecoy, status: IN_REVIEW, pre: null, park: null, written: 1 },
          { id: deletedMoverRequeue, status: IN_REVIEW, pre: null, park: null, written: 20 },
          { id: staleVerdictRequeue, status: IN_REVIEW, pre: null, park: null, written: 20 },
          { id: staleMoveWedge, status: IN_REVIEW, pre: null, park: null, written: 20 },
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
      await seedReview(maskedRestore, 'APPROVED', 6);
      await seedReview(maskedBlock, 'APPROVED', 6);
      await seedReview(restoredRequeue, 'APPROVED', 30);
      await seedReview(noteDecoy, 'APPROVED', 6);
      await seedReview(deletedMoverRequeue, 'APPROVED', 30);
      // the CURRENT round (2) was decided 30 min ago; round 1's verdict is LATER (10 min
      // ago) — the owner move at 20 min outranks the round it actually answered, and must
      // outrank round 1's debris too (the round binding in the gap clause)
      await seedReview(staleVerdictRequeue, 'APPROVED', 10, 10, 1);
      await seedReview(staleVerdictRequeue, 'APPROVED', 30, 40, 2);
      // the STALE-MOVE control (#438): the round decided 10 min ago, the ONLY owner move
      // landed 20 min ago — a move exists, but not AFTER the verdict, so the wedge fires.
      // This is the one shape that separates "a move exists" from "a move after the
      // verdict exists": dropping the gap clause's time term silences this seed and every
      // other seed stays green.
      await seedReview(staleMoveWedge, 'APPROVED', 10, 10, 1);
      // Status activity rows: the discriminator is the activity ROW (body + its 1:1
      // payload kind), never the author — `author_id` is ON DELETE SET NULL, so a
      // deleted mover's row must still read as an owner move. tasks.setStatus is the
      // only writer of a `status: …` body; a NOTE/VERDICT row whose text merely starts
      // with `status: ` must NOT count (the free-text forgery the arm is pinned against).
      const seedStatusActivity = async (
        taskId: string,
        minutesAgo: number,
        body: string,
        author: string | null,
        kind: 'STATUS' | 'NOTE' = 'STATUS',
      ) => {
        const msgId = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, author_id, body, created_at)
           values ($1, $2, $3, $4, now() - ($5::int * interval '1 minute'))`,
          [msgId, taskId, author, body, minutesAgo],
        );
        await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
          msgId,
          { kind },
        ]);
      };
      // the legal manual re-queue over an already-decided round: the owner's move is NEWER
      // than the verdict (the whole point of the discriminator)
      await seedStatusActivity(legalRequeue, 3, 'status: doing → in-review', adminId);
      await seedStatusActivity(inReviewManual, 2, 'status: doing → in-review', adminId);
      // maskedRestore: block (-12) → killing verdict (-6) → child-restore (-2), task write -1
      await seedStatusActivity(maskedRestore, 12, 'auto-blocked: 1 subtask(s) open', null);
      await seedStatusActivity(maskedRestore, 2, `unblocked: all subtasks terminal → ${IN_REVIEW}`, null);
      // maskedBlock: block (-10) → killing verdict (-6) → a title edit wrote the task row (-1)
      await seedStatusActivity(maskedBlock, 10, 'auto-blocked: 1 subtask(s) open', null);
      // restoredRequeue LEGAL: verdict (-30) → owner re-queue (-25) → block (-20) → restore (-12)
      await seedStatusActivity(restoredRequeue, 25, 'status: todo → in-review', adminId);
      await seedStatusActivity(restoredRequeue, 20, 'auto-blocked: 1 subtask(s) open', null);
      await seedStatusActivity(restoredRequeue, 12, `unblocked: all subtasks terminal → ${IN_REVIEW}`, null);
      // the FREE-TEXT forgery control: a NOTE whose body starts with `status: ` is not a
      // status write — the wedge must still fire (the arm keys on the payload kind too)
      await seedStatusActivity(noteDecoy, 2, 'status: blocked on the vendor cert', adminId, 'NOTE');
      // the DELETED-MOVER control: the author was deleted (FK sets NULL) but the move is
      // still an owner move — body + kind decide, never the author
      await seedStatusActivity(deletedMoverRequeue, 20, 'status: doing → in-review', null);
      // the STALE-VERDICT control: an owner move after the CURRENT round's verdict, an
      // older round holding a later verdict — the round binding must keep this silent
      await seedStatusActivity(staleVerdictRequeue, 20, 'status: doing → in-review', adminId);
      // the owner move PREDATES the verdict (20 min ago vs decided 10 min ago)
      await seedStatusActivity(staleMoveWedge, 20, 'status: doing → in-review', adminId);

      const rows = await sql.unsafe(strandSql);
      // union columns are unnamed: key on the arm's own label column, never on aliases
      const wedge = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'wedge');
      expect(wedge, 'the emitted SQL must carry the wedge arm').toBeTruthy();
      const fired = new Set(String(wedge?.[1] ?? 'none').split(','));

      expect(fired, 'a gating block recording an in-review home with a closed decided round is the wedge').toContain(
        illegal,
      );
      expect(fired, 'the in_review branch keeps detecting its own shape').toContain(inReviewWedge);
      expect(
        fired,
        'a child-restore after the killing verdict (block → verdict → restore) is the MASKED wedge (#430)',
      ).toContain(maskedRestore);
      expect(fired, 'a title/assignee edit after the killing verdict cannot mask the block branch (#430)').toContain(
        maskedBlock,
      );
      expect(
        fired,
        'an owner re-queue that PRECEDES the block/restore is a legal state — the authored move outranks the verdict',
      ).not.toContain(restoredRequeue);
      expect(
        fired,
        'a NOTE whose body merely starts with `status: ` is not a status write — it must not mask the wedge',
      ).toContain(noteDecoy);
      expect(
        fired,
        'a deleted mover row (author_id NULL via ON DELETE SET NULL) is still an owner move — body + kind decide',
      ).not.toContain(deletedMoverRequeue);
      expect(
        fired,
        'an owner move newer than the CURRENT round verdict keeps the task legal even when an older round holds a later verdict',
      ).not.toContain(staleVerdictRequeue);
      expect(
        fired,
        'an owner move PREDATING the round verdict cannot mask the wedge — the time term, not mere existence, decides (#438)',
      ).toContain(staleMoveWedge);
      // VERSION-GATE CONTROL (#430): below the atomic-writer release (2.78.24) the arm
      // must keep the retired verdict-vs-write rule — the plain wedge fires, while the
      // shapes only the owner record can unmask (a child-restore or title edit after the
      // verdict) stay silent there, because an old image can lose a move's record.
      const preEmitted = await $`bash ${script} --strand-sql 2.78.23 2`.nothrow().quiet();
      expect(preEmitted.exitCode, preEmitted.stderr.toString()).toBe(0);
      const preRows = await sql.unsafe(preEmitted.stdout.toString().trim());
      const preFired = new Set(
        String(preRows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'wedge')?.[1] ?? 'none').split(
          ',',
        ),
      );
      expect(preFired, 'the pre-floor rule still catches the plain wedge').toContain(illegal);
      expect(preFired, 'the pre-floor rule is masked by a write after the verdict — by design').not.toContain(
        maskedRestore,
      );
      expect(preFired, 'the pre-floor rule has no owner record to consult').not.toContain(noteDecoy);
      expect(fired, 'a live block still holds a PENDING row — not a wedge').not.toContain(liveBlock);
      expect(
        fired,
        'a block over an already-decided round (verdict older than the owner move and the block write) is legal',
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
      expect(
        fired,
        'a verdict older than the task write with an owner move after it is a legal manual move',
      ).not.toContain(inReviewManual);
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
