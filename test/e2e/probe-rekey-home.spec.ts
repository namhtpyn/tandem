import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the RE-KEYED-HOME arm (#435) reads the re-key
// sibling of the ORPHAN-HOME shape: a PAUSED row where a recorded block/park home
// RESOLVES to a TERMINAL (done/cancelled-category) task_statuses row — the home EXISTS,
// but its category was re-keyed after the block recorded it (statuses.save's
// block-state-home guard is a read-then-write check; the gating block landing inside its
// read->upsert window is the declared residual producer). TERMINAL-only is a declared
// boundary: a re-key into a NON-terminal category is SQL-indistinguishable from the
// declared legal hold-landing class (a repair round re-opened on a ready/working status,
// then gating-blocked, the block recording a non-review home legally) and is OUT of this
// arm, never a false alarm here. The settle flip then refuses on the terminal home,
// the round closes on the verdict row with NO task write, and the task stays blocked: the
// wedge's in_review branch cannot see it (the origin resolves outside in_review), the
// ORPHAN-HOME arm cannot (the home exists), and no sweep reaches it: the PRE-block half
// reads as owner-settled (`settledByOwner`: paused + a pre_block_status resolving
// terminal), and the PARK half is excluded from every review sweep by the
// `park_from_status IS NULL` term of the flow-ownership predicate (its heals fire only
// through a park restore, which resolves the still-existing terminal row). A
// terminal-by-owner shape is excluded BY CONSTRUCTION, not by a category
// term — a DIRECT owner settle leaves the paused category and clears both origins in the
// same statement; the residual owner-settle shape is the machine #423 re-block, excluded
// by the ordering. That is why the arm fires on a resolved done/cancelled home when no
// verdict predates the block write (the counterexample: in_review -> done under a blocked
// task). Neither origin may resolve into review (a resolvable in-review home still lets
// the flip land: the orphan arm's exclusion, mirrored), and the wedge's current-round
// clause plus a MIN ordering — EVERY verdict of max(round) NEWER than the task's last
// write, not just the newest — apply: the MIN test excludes the #423 re-block and the
// #467 flip->supersede window a max() test misreads, and it is the reason the lateVerdict
// seed below must stay silent. The arm is VERSION-independent (no image floor — a pre-guard image produces the
// strand too) but COLUMN-gated exactly like the orphan arm: it reads BOTH origin columns,
// and on a one-column image it would kill the whole UNION, so it must vanish there. It is
// pinned on the SQL that ships: the probe emits it (--strand-sql) and this spec executes
// exactly those bytes against the e2e database.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const CANCELLED = '01a14743-43f5-759d-a00e-b0f2a5a04f4c';
/** a canonical uuid that names no task_statuses row — a DELETED home, the orphan arm's shape */
const DANGLING = '01a14743-dead-7e57-8000-000000000001';

test.describe('prod probe re-keyed-home arm (#435)', () => {
  test('fires on a re-keyed home over a closed round, silent on every legal shape', async () => {
    // the PRE-GUARD VERSION pair on purpose: the arm is deliberately version-independent,
    // so a pre-guard image (which still produces the strand) must emit it too — but only
    // at the two-column gate, since the arm reads both origin columns
    const emitted = await $`bash ${script} --strand-sql 2.78.19 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'rekeyhome'");
    const oneColumn = await $`bash ${script} --strand-sql 2.78.19 1`.nothrow().quiet();
    expect(oneColumn.exitCode, oneColumn.stderr.toString()).toBe(0);
    expect(oneColumn.stdout.toString(), 'the arm must vanish without the park column').not.toContain('rekeyhome');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for a live-reviewer seed').not.toBe('');

      // seeded homes must exist (the re-key test is a RESOLVE, never a dangle — the
      // dangling shape belongs to the orphan-home arm)
      for (const seed of [DOING, DONE, IN_REVIEW, BLOCKED, CANCELLED, TODO]) {
        const home = await sql.unsafe('select id from task_statuses where id = $1', [seed]);
        expect(home.length, `seed status ${seed} must exist in the e2e boot rows`).toBe(1);
      }

      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const tag = crypto.randomUUID();
      const rekeyDone = `probe-rekey-done-${tag}`; // fires: THE counterexample — block home re-keyed in_review -> done
      const rekeyDoing = `probe-rekey-doing-${tag}`; // silent: a NON-terminal re-key is the declared boundary
      const rekeyCancelled = `probe-rekey-cancelled-${tag}`; // fires: a cancelled-category home is the same wedge (no owner settle cleared the origin)
      const parkRekey = `probe-rekey-park-${tag}`; // fires: a PARK-only origin re-keyed terminal
      const bothRekey = `probe-rekey-both-${tag}`; // fires: either column re-keyed is enough
      const bothMixed = `probe-rekey-bothmixed-${tag}`; // fires: a MIXED pair (terminal + non-terminal) still fires on the terminal one
      const mixedReview = `probe-rekey-mixedrev-${tag}`; // silent: the park origin still resolves to in-review
      const resolvable = `probe-rekey-resolvable-${tag}`; // silent: the block home still resolves to in-review
      const legalRequeue = `probe-rekey-verdictold-${tag}`; // silent: the verdict predates the last write
      const liveRound = `probe-rekey-live-${tag}`; // silent: a PENDING row keeps the round open
      const tornDown = `probe-rekey-void-${tag}`; // silent: the round holds no verdict row
      const manualBlock = `probe-rekey-manual-${tag}`; // silent: a hand-made block writes no origin
      const danglingOnly = `probe-rekey-dangle-${tag}`; // silent: an UNRESOLVABLE home is the orphan arm's shape
      const egressRekey = `probe-rekey-egress-${tag}`; // silent: a stale origin on a NON-paused row is #427's shape
      const staleRound = `probe-rekey-staleround-${tag}`; // silent: the VERDICT must sit in max(round)
      const lateVerdict = `probe-rekey-lateverdict-${tag}`; // silent: flip->supersede window (#467), min() ordering

      // updated_at = now() - written minutes (the block write's stamp); the round's rows
      // sit at created - 10 minutes and decided - N minutes, so a verdict decided 1 minute
      // ago is NEWER than a write 5 minutes ago (the wedge) and a verdict decided 10
      // minutes ago is OLDER than a write 1 minute ago (the legal ordering shape)
      const seedTasks = [
        { id: rekeyDone, status: BLOCKED, pre: DONE, park: null, written: 5 },
        // the DECLARED boundary on the BLOCK column: a gating block legally records a
        // ready/working home (the hold-landing class), so a non-terminal PRE home is not
        // this arm's shape — the terminal term is what keeps it silent
        { id: rekeyDoing, status: BLOCKED, pre: DOING, park: null, written: 5 },
        { id: rekeyCancelled, status: BLOCKED, pre: CANCELLED, park: null, written: 5 },
        // a PARK-only origin: a park always records an in-review home, so a terminal park
        // home is by construction a re-key; the round closes when its single reviewer
        // decides (a still-PENDING voter correctly keeps the arm silent — live round)
        { id: parkRekey, status: BLOCKED, pre: null, park: DONE, written: 5 },
        // a row carrying both origins (no live writer emits that, but the schema permits
        // it) still fires when either of them was re-keyed
        { id: bothRekey, status: BLOCKED, pre: DONE, park: DONE, written: 5 },
        // the per-column OR against an all-present-terminals mutant: the non-terminal
        // park home must not suppress the terminal pre home
        { id: bothMixed, status: BLOCKED, pre: DONE, park: DOING, written: 5 },
        { id: mixedReview, status: BLOCKED, pre: DONE, park: IN_REVIEW, written: 5 },
        { id: resolvable, status: BLOCKED, pre: IN_REVIEW, park: null, written: 5 },
        // a gating block landing AFTER the verdict closed the round (verdict older than
        // the write) is the legal shape the write-vs-verdict discriminator exists for
        { id: legalRequeue, status: BLOCKED, pre: DONE, park: null, written: 1 },
        { id: liveRound, status: BLOCKED, pre: DONE, park: null, written: 5 },
        { id: tornDown, status: BLOCKED, pre: DONE, park: null, written: 5 },
        { id: manualBlock, status: BLOCKED, pre: null, park: null, written: 5 },
        // a DELETED home resolves to nothing — the orphan-home arm owns that shape
        { id: danglingOnly, status: BLOCKED, pre: DANGLING, park: null, written: 5 },
        // a stale origin on a non-paused row is the EGRESS-ORIGIN shape (#427): the
        // paused clause must own this exclusion
        { id: egressRekey, status: DOING, pre: DONE, park: null, written: 5 },
        // round 1 holds a NEWER verdict but round 2 (max) closed with NO verdict: the
        // verdict-round binding must read max(round) only — without it, round 1's
        // verdict (1m) beats the write (5m) and the row fires wrongly
        { id: staleRound, status: BLOCKED, pre: DONE, park: null, written: 5 },
        // the #423 re-block + flip->supersede window (#467): the APPLIED verdict (10m)
        // predates the re-block write (5m); a late second reviewer's CAS (1m) lands
        // after it — the MIN ordering must stay silent (a MAX test would fire)
        { id: lateVerdict, status: BLOCKED, pre: DONE, park: null, written: 5 },
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
        round = 1,
      ) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, $3, $4, $5, now() - interval '10 minutes',
                   case when $6::int is null then null else now() - ($6::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, round, status, reviewerId, decidedMinutesAgo],
        );
      };
      await seedReview(rekeyDone, 'APPROVED', 1);
      await seedReview(rekeyDoing, 'CHANGE_REQUESTED', 1);
      await seedReview(rekeyCancelled, 'REJECTED', 1);
      await seedReview(parkRekey, 'APPROVED', 1);
      await seedReview(bothRekey, 'APPROVED', 1);
      await seedReview(bothMixed, 'APPROVED', 1);
      await seedReview(mixedReview, 'APPROVED', 1);
      await seedReview(resolvable, 'APPROVED', 0); // inside the #472 heal's grace: the live tick must not drain the fixture mid-spec
      await seedReview(legalRequeue, 'APPROVED', 10);
      await seedReview(liveRound, 'APPROVED', 1);
      await seedReview(liveRound, 'PENDING', null, adminId);
      // torn down INSIDE the block: no VERDICT row, so it is not a decided round at
      // all — the non-verdict rows are NEWER than the write on purpose, so the verdict
      // status filter (never the ordering) is the only exclusion
      await seedReview(tornDown, 'SUPERSEDED', 1);
      await seedReview(tornDown, 'ESCALATED', 2);
      await seedReview(manualBlock, 'APPROVED', 1);
      await seedReview(danglingOnly, 'APPROVED', 1);
      await seedReview(egressRekey, 'APPROVED', 1);
      await seedReview(staleRound, 'APPROVED', 1);
      await seedReview(staleRound, 'SUPERSEDED', 2, null, 2);
      await seedReview(lateVerdict, 'APPROVED', 10);
      await seedReview(lateVerdict, 'APPROVED', 1);

      const rows = await sql.unsafe(strandSql);
      // union columns are unnamed: key on the arm's own label column, never on aliases
      const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'rekeyhome');
      expect(arm, 'the emitted SQL must carry the re-keyed-home arm').toBeTruthy();
      const fired = new Set(String(arm?.[1] ?? 'none').split(','));

      expect(fired, 'a block home re-keyed in_review -> done over a decided round is the strand').toContain(rekeyDone);
      expect(
        fired,
        'a re-key into a NON-terminal category is the declared boundary: the legal hold-landing block shares the shape',
      ).not.toContain(rekeyDoing);
      expect(
        fired,
        'a cancelled-category home is the same wedge: no legal owner settle can leave an origin behind',
      ).toContain(rekeyCancelled);
      expect(fired, 'a PARK-only origin re-keyed terminal strands through the park path').toContain(parkRekey);
      expect(fired, 'either column re-keyed is enough').toContain(bothRekey);
      expect(fired, 'a MIXED pair fires on the terminal home (the per-column OR)').toContain(bothMixed);

      expect(
        fired,
        'a park origin still resolving to in-review lets the settle flip land — the orphan arm exclusion mirrored',
      ).not.toContain(mixedReview);
      expect(fired, 'a home still resolving to in-review is not this shape').not.toContain(resolvable);
      expect(
        fired,
        'a verdict OLDER than the last write is a gating block over an already-decided round — legal',
      ).not.toContain(legalRequeue);
      expect(fired, 'a PENDING row keeps the round open').not.toContain(liveRound);
      expect(fired, 'no verdict row means no decided round').not.toContain(tornDown);
      expect(fired, 'a hand-made block writes no origin').not.toContain(manualBlock);
      expect(fired, 'an UNRESOLVABLE home is the orphan arm shape, never this one').not.toContain(danglingOnly);
      expect(fired, 'a stale origin on a NON-paused row belongs to the egress-origin arm').not.toContain(egressRekey);
      expect(
        fired,
        'the verdict must sit in max(round): a newer verdict on a SUPERSEDED round is not this shape',
      ).not.toContain(staleRound);
      expect(
        fired,
        'a late verdict CAS after the re-block (#467) must not read as a re-key: the MIN ordering excludes it',
      ).not.toContain(lateVerdict);
    } finally {
      await sql.end();
    }
  });
  test('per-verdict record ordering at and above the block-record floor (#468)', async () => {
    // The record's OWN timestamp is the discriminator: a verdict NEWER than the record
    // means the round was LIVE when the block/park landed. Below the floor (and for a
    // row carrying NO record) the retired MIN-vs-write test stands, so the SAME seeds
    // must read differently at 2.78.37 and 2.78.38.
    const preFloor = await $`bash ${script} --strand-sql 2.78.37 2`.nothrow().quiet();
    expect(preFloor.exitCode, preFloor.stderr.toString()).toBe(0);
    const floored = await $`bash ${script} --strand-sql 2.78.38 2`.nothrow().quiet();
    expect(floored.exitCode, floored.stderr.toString()).toBe(0);
    // the per-verdict term is the floored bytes only: a pre-floor emission that carried
    // it would fire on the #467 late-CAS class the MIN test exists to exclude
    expect(preFloor.stdout.toString()).not.toContain(
      'coalesce(r.decided_at, r.created_at) > (select max(m.created_at)',
    );
    expect(floored.stdout.toString()).toContain('coalesce(r.decided_at, r.created_at) > (select max(m.created_at)');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const splitWedge = `probe-split-wedge-${tag}`;
      const recordedLegal = `probe-recorded-legal-${tag}`;
      const masked = `probe-record-masked-${tag}`;
      const recordless = `probe-recordless-${tag}`;
      const recordlessFire = `probe-recordless-fire-${tag}`;
      const parkSplit = `probe-park-split-${tag}`;
      const seedTasks = [
        // one vote BEFORE the block record, the settling vote AFTER: the split-timing
        // wedge the aggregate MIN missed (verdicts 10m + 1m, record 5m)
        { id: splitWedge, pre: DONE, park: null, written: 5 },
        // every verdict older than the record: the legal #423 settle-then-reblock
        { id: recordedLegal, pre: DONE, park: null, written: 5 },
        // a LATER task write (1m) past every verdict (10m, 2m): the stamp test masks the
        // wedge (min 10m is older than 1m), the record term (2m > 5m) does not
        { id: masked, pre: DONE, park: null, written: 1 },
        // NO record at all on a floored image: the MIN fallback keeps the #467-era pin
        { id: recordless, pre: DONE, park: null, written: 5 },
        { id: recordlessFire, pre: DONE, park: null, written: 5 },
        // the park path orders against its OWN record: same split shape, park origin
        { id: parkSplit, pre: null, park: DONE, written: 5 },
      ];
      for (const t of seedTasks) {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, now(), now() - ($6::int * interval '1 minute'))`,
          [t.id, t.id, BLOCKED, t.pre, t.park, t.written],
        );
      }
      const seedRecord = async (taskId: string, body: string, createdAtMinutesAgo: number) => {
        const messageId = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, author_id, body, created_at)
           values ($1, $2, null, $3, now() - ($4::int * interval '1 minute'))`,
          [messageId, taskId, body, createdAtMinutesAgo],
        );
        await sql.unsafe(
          `insert into task_message_activities (message_id, payload) values ($1, '{"kind":"STATUS"}'::jsonb)`,
          [messageId],
        );
      };
      await seedRecord(splitWedge, 'auto-blocked: 1 subtask(s) open', 5);
      await seedRecord(recordedLegal, 'auto-blocked: 1 subtask(s) open', 5);
      await seedRecord(masked, 'auto-blocked: 1 subtask(s) open', 5);
      await seedRecord(parkSplit, 'review parked — reconciliation needed', 5);

      const seedReview = async (taskId: string, status: string, decidedMinutesAgo: number | null) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, 1, $3, null, now() - interval '10 minutes',
                   case when $4::int is null then null else now() - ($4::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, status, decidedMinutesAgo],
        );
      };
      await seedReview(splitWedge, 'APPROVED', 10);
      await seedReview(splitWedge, 'APPROVED', 1);
      await seedReview(recordedLegal, 'APPROVED', 10);
      await seedReview(masked, 'APPROVED', 10);
      await seedReview(masked, 'APPROVED', 2);
      await seedReview(recordless, 'APPROVED', 10);
      await seedReview(recordless, 'APPROVED', 1);
      await seedReview(recordlessFire, 'APPROVED', 1);
      await seedReview(parkSplit, 'APPROVED', 10);
      await seedReview(parkSplit, 'APPROVED', 1);

      const firedFor = async (strandSql: string) => {
        const rows = (await sql.unsafe(strandSql)) as Record<string, unknown>[];
        const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'rekeyhome');
        expect(arm, 'the emitted SQL must carry the re-keyed-home arm').toBeTruthy();
        return new Set(String(arm?.[1] ?? 'none').split(','));
      };

      const pre = await firedFor(preFloor.stdout.toString().trim());
      expect(pre, 'below the floor the record is not read: the split wedge reads as the legal MIN shape').not.toContain(
        splitWedge,
      );
      expect(pre, 'the stamp test fires the single post-write verdict').toContain(recordlessFire);
      expect(pre, 'a later task write masks the wedge below the floor').not.toContain(masked);

      const post = await firedFor(floored.stdout.toString().trim());
      expect(post, 'a round SPLIT across the block record is the wedge (#468)').toContain(splitWedge);
      expect(post, 'an all-older round is the legal #423 re-block').not.toContain(recordedLegal);
      expect(post, 'the record term is not maskable by a later task write').toContain(masked);
      expect(post, 'a record-less row keeps the MIN fallback: the #467 era pin').not.toContain(recordless);
      expect(post, 'the record-less fallback still fires the counterexample').toContain(recordlessFire);
      expect(post, 'the park origin orders against the park record').toContain(parkSplit);
    } finally {
      await sql.end();
    }
  });
});
