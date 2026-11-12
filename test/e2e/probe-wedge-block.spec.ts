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
      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const illegal = `probe-wedge-block-${crypto.randomUUID()}`; // fires: block + closed decided round
      const liveBlock = `probe-wedge-live-${crypto.randomUUID()}`; // legal: PENDING row in the round
      const parked = `probe-wedge-park-${crypto.randomUUID()}`; // legal: park carries park_from_status
      const parkedStaleOrigin = `probe-wedge-park-origin-${crypto.randomUUID()}`; // legal: park owns the row
      const manualBlock = `probe-wedge-manual-${crypto.randomUUID()}`; // legal: hand-made block, no origins
      const todoOrigin = `probe-wedge-todo-${crypto.randomUUID()}`; // legal: origin resolves to ready
      const tornDown = `probe-wedge-void-${crypto.randomUUID()}`; // legal: no verdict row in the round
      const inReviewWedge = `probe-wedge-ir-${crypto.randomUUID()}`; // fires: in_review branch
      const inReviewManual = `probe-wedge-irm-${crypto.randomUUID()}`; // legal: verdict older than write

      // task write age (minutes ago) per seed; the wedge needs the verdict NEWER than it
      const seedTasks: Array<{ id: string; status: string; pre: string | null; park: string | null; written: number }> =
        [
          { id: illegal, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: liveBlock, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: parked, status: BLOCKED, pre: null, park: IN_REVIEW, written: 5 },
          // #427 documents gating origins surviving a non-settle egress; if one ever meets a
          // park on a PAUSED row, the PARK owns the round (owner resolution / re-arm), so the
          // arm must stay silent — its park discriminator is the clause that decides.
          { id: parkedStaleOrigin, status: BLOCKED, pre: IN_REVIEW, park: IN_REVIEW, written: 5 },
          { id: manualBlock, status: BLOCKED, pre: null, park: null, written: 5 },
          { id: todoOrigin, status: BLOCKED, pre: TODO, park: null, written: 5 },
          { id: tornDown, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
          { id: inReviewWedge, status: IN_REVIEW, pre: null, park: null, written: 5 },
          { id: inReviewManual, status: IN_REVIEW, pre: null, park: null, written: 1 },
        ];
      for (const t of seedTasks) {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - ($6::int * interval '1 minute'))`,
          [t.id, t.id, t.status, t.pre, t.park, t.written],
        );
      }

      // decidedMinutesAgo = null seeds a still-PENDING row
      const seedReview = async (taskId: string, status: string, decidedMinutesAgo: number | null) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, created_at, decided_at)
           values ($1, $2, 1, $3, now() - interval '10 minutes',
                   case when $4::int is null then null else now() - ($4::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, status, decidedMinutesAgo],
        );
      };
      await seedReview(illegal, 'APPROVED', 1);
      await seedReview(liveBlock, 'APPROVED', 1);
      await seedReview(liveBlock, 'PENDING', null);
      await seedReview(parked, 'APPROVED', 1);
      await seedReview(parkedStaleOrigin, 'APPROVED', 1);
      await seedReview(manualBlock, 'APPROVED', 1);
      await seedReview(todoOrigin, 'APPROVED', 1);
      await seedReview(tornDown, 'SUPERSEDED', null);
      await seedReview(tornDown, 'ESCALATED', null);
      await seedReview(inReviewWedge, 'CHANGE_REQUESTED', 1);
      await seedReview(inReviewManual, 'APPROVED', 10);

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
      expect(fired, 'a park carries park_from_status — not a gating block').not.toContain(parked);
      expect(fired, 'a park origin owns a paused row even with a stale gating origin').not.toContain(parkedStaleOrigin);
      expect(fired, 'a hand-made block clears both origins — legal').not.toContain(manualBlock);
      expect(fired, 'a block whose origin resolves to a non-review status is not the review flow').not.toContain(
        todoOrigin,
      );
      expect(fired, 'a torn-down round holds no verdict row — not a decided round').not.toContain(tornDown);
      expect(fired, 'a verdict older than the task write is a legal manual move').not.toContain(inReviewManual);
    } finally {
      await sql.close();
    }
  });
});
