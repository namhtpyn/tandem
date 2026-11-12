import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the ORPHAN-HOME arm (#432) reads a PAUSED row
// whose recorded block/park home names NO task_statuses row (the home was deleted after
// the block recorded it) — and whose OTHER origin does not resolve into review, since a
// resolvable park home still lets the settle flip land — together with the wedge's
// current-round predicate: no PENDING
// row in `max(round)`, and the newest VERDICT row of that round NEWER than the task's
// last write. No legal write path produces it — a gating block records the task's own
// status, a park records an in-review home, a hand-made block clears both origins, and
// `statuses.remove` re-homes every recorded reference inside its delete transaction — so
// a surviving count means a direct-SQL delete or a guard regression. The arm is
// VERSION-independent (no image floor — a pre-guard image produces the strand too) but
// COLUMN-gated exactly like the block branch: it reads BOTH origin columns, and on a
// one-column image it would kill the whole UNION, so it must vanish there. It is pinned
// on the SQL that ships: the probe emits it (--strand-sql) and this spec executes exactly
// those bytes against the e2e database.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
/** a canonical uuid that names no task_statuses row — the shape a deleted home leaves */
const DANGLING = '01a14743-dead-7e57-8000-000000000001';
const DANGLING_TWO = '01a14743-dead-7e57-8000-000000000002';

test.describe('prod probe orphan-home arm (#432)', () => {
  test('fires on a dangling home over a closed round, silent on every legal shape', async () => {
    // the PRE-GUARD VERSION pair on purpose: the arm is deliberately version-independent,
    // so a pre-guard image (which still produces the strand) must emit it too — but only
    // at the two-column gate, since the arm reads both origin columns
    const emitted = await $`bash ${script} --strand-sql 2.78.19 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'orphanhome'");
    const oneColumn = await $`bash ${script} --strand-sql 2.78.19 1`.nothrow().quiet();
    expect(oneColumn.exitCode, oneColumn.stderr.toString()).toBe(0);
    expect(oneColumn.stdout.toString(), 'the arm must vanish without the park column').not.toContain('orphanhome');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for a live-reviewer seed').not.toBe('');
      for (const seed of [DANGLING, DANGLING_TWO]) {
        const danglingRow = await sql.unsafe('select id from task_statuses where id = $1', [seed]);
        expect(danglingRow.length, 'the seed id must name no status row').toBe(0);
      }

      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const tag = crypto.randomUUID();
      const danglingBlock = `probe-orphan-block-${tag}`; // fires: block home dangling, verdict after the write
      const danglingPark = `probe-orphan-park-${tag}`; // fires: park home dangling, same shape
      const mixedInert = `probe-orphan-mixed-${tag}`; // fires: one origin dangles, the other resolves OUTSIDE review
      const mixedReview = `probe-orphan-mixedrev-${tag}`; // silent: the park origin still resolves to in-review
      const bothDangling = `probe-orphan-both-${tag}`; // fires: both origins dangle
      const legalRequeue = `probe-orphan-requeue-${tag}`; // legal: the verdict predates the last write
      const liveRound = `probe-orphan-live-${tag}`; // legal: a PENDING row keeps the round open
      const tornDown = `probe-orphan-void-${tag}`; // legal: the round holds no verdict row
      const manualBlock = `probe-orphan-manual-${tag}`; // legal: a hand-made block writes no origin
      const nonPaused = `probe-orphan-doing-${tag}`; // legal: a stale origin on a NON-paused row
      const resolvable = `probe-orphan-resolvable-${tag}`; // the WEDGE block branch owns this one

      // task write age (minutes ago) per seed; the arm needs the verdict NEWER than it
      const seedTasks: Array<{ id: string; status: string; pre: string | null; park: string | null; written: number }> =
        [
          { id: danglingBlock, status: BLOCKED, pre: DANGLING, park: null, written: 5 },
          { id: danglingPark, status: BLOCKED, pre: null, park: DANGLING, written: 5 },
          // both origins on one row is not producible by a live writer, but the schema
          // permits it: the arm fires per COLUMN, so one dangling origin is enough when
          // the other does not resolve into review (a resolvable park home still lets the
          // settle flip land — that row belongs to no arm)
          { id: mixedInert, status: BLOCKED, pre: DANGLING, park: TODO, written: 5 },
          { id: mixedReview, status: BLOCKED, pre: DANGLING, park: IN_REVIEW, written: 5 },
          { id: bothDangling, status: BLOCKED, pre: DANGLING, park: DANGLING_TWO, written: 5 },
          // a block over an already-decided round (the verdict predates the block write) is
          // the legal manual-move shape the write-vs-verdict discriminator exists for
          { id: legalRequeue, status: BLOCKED, pre: DANGLING, park: null, written: 1 },
          { id: liveRound, status: BLOCKED, pre: DANGLING, park: null, written: 5 },
          { id: tornDown, status: BLOCKED, pre: DANGLING, park: null, written: 5 },
          { id: manualBlock, status: BLOCKED, pre: null, park: null, written: 5 },
          { id: nonPaused, status: DOING, pre: DANGLING, park: null, written: 5 },
          { id: resolvable, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
        ];
      for (const t of seedTasks) {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, now(), now() - ($6::int * interval '1 minute'))`,
          [t.id, t.id, t.status, t.pre, t.park, t.written],
        );
      }

      // decidedMinutesAgo = null seeds a still-PENDING row (a live round); createdMinutesAgo
      // places the round's rows relative to the task's last write
      const seedReview = async (
        taskId: string,
        status: string,
        decidedMinutesAgo: number | null,
        reviewerId: string | null = null,
      ) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, 1, $3, $4, now() - interval '10 minutes',
                   case when $5::int is null then null else now() - ($5::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, status, reviewerId, decidedMinutesAgo],
        );
      };
      await seedReview(danglingBlock, 'APPROVED', 1);
      await seedReview(danglingPark, 'CHANGE_REQUESTED', 1);
      await seedReview(mixedInert, 'APPROVED', 1);
      await seedReview(mixedReview, 'APPROVED', 1);
      await seedReview(bothDangling, 'APPROVED', 1);
      await seedReview(legalRequeue, 'APPROVED', 10);
      await seedReview(liveRound, 'APPROVED', 1);
      await seedReview(liveRound, 'PENDING', null, adminId);
      // torn down INSIDE the block: no verdict row, so it is not a decided round at all
      await seedReview(tornDown, 'SUPERSEDED', null);
      await seedReview(tornDown, 'ESCALATED', null);
      await seedReview(manualBlock, 'APPROVED', 1);
      await seedReview(nonPaused, 'APPROVED', 1);
      await seedReview(resolvable, 'APPROVED', 1);

      const rows = await sql.unsafe(strandSql);
      // union columns are unnamed: key on the arm's own label column, never on aliases
      const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'orphanhome');
      expect(arm, 'the emitted SQL must carry the orphan-home arm').toBeTruthy();
      const fired = new Set(String(arm?.[1] ?? 'none').split(','));

      expect(fired, 'a block whose recorded home was deleted over a decided round is the strand').toContain(
        danglingBlock,
      );
      expect(fired, 'a park whose recorded home was deleted strands the same way').toContain(danglingPark);
      expect(fired, 'either column dangling is enough when the other home is outside review').toContain(mixedInert);
      expect(fired, 'both origins dangling is the same shape').toContain(bothDangling);
      expect(fired, 'a resolvable in-review park home still lets the settle flip land — not this arm').not.toContain(
        mixedReview,
      );
      expect(fired, 'a verdict older than the task write is a legal manual move').not.toContain(legalRequeue);
      expect(fired, 'a PENDING row in the current round means the round is still live').not.toContain(liveRound);
      expect(fired, 'a round with no verdict row is not a decided round').not.toContain(tornDown);
      expect(fired, 'a hand-made block writes no origin — nothing to dangle').not.toContain(manualBlock);
      expect(fired, 'a stale origin on a NON-paused row is not a block').not.toContain(nonPaused);
      expect(fired, 'a home that still RESOLVES belongs to the wedge block branch, not this arm').not.toContain(
        resolvable,
      );
    } finally {
      await sql.close();
    }
  });
});
