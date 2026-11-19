import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the RE-KEYED-HOME arm (#435) reads the re-key
// sibling of the ORPHAN-HOME shape: a PAUSED row where a recorded block/park home
// RESOLVES to a TERMINAL (done/cancelled-category) task_statuses row — the home EXISTS,
// but its category was re-keyed after the block recorded it (statuses.save's
// block-state-home guard is a read-then-write check; the gating block landing inside its
// read->upsert window is the declared residual producer). TERMINAL-only is a declared
// SCOPE boundary, not a SQL impossibility: a hold-landing repair round re-opened on a
// ready/working status and then gating-blocked records a non-review home whose category
// MATCHES the one it resolves, so the category record separates it from a re-key into a
// NON-terminal category — in scope from 2.78.41 (#496): the recorded-vs-resolved equality
// is the discriminator there (no ordering term applies, and the legal hold-landing block
// records the category it resolves). The settle flip then refuses on the terminal home,
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
// by the ordering. The counterexample is the resolved done/cancelled home under a blocked
// task whose round carries at least one verdict NEWER than the record that made it terminal
// (in_review -> done with the settle never applied). Neither origin may resolve into
// review (a resolvable in-review home still lets the flip land: the orphan arm's
// exclusion, mirrored), and the wedge's current-round clause applies. The ORDERING is
// floor-gated: below 2.78.38 (and on a row carrying no note of the origin's kind) the
// retired MIN test — EVERY verdict of max(round) NEWER than the task's last write, not
// just the newest — excludes the #423 re-block and the #467 flip->supersede window a
// max() test misreads, which is why the lateVerdict seed below must stay silent on the
// pre-floor emission; at/above the floor ANY verdict newer than the origin's OWN record
// is the split-timing wedge (#468), pinned by the second test. The arm is
// VERSION-independent (no image floor — a pre-guard image produces the
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
      const rekeyDoing = `probe-rekey-doing-${tag}`; // silent here: no category record on the note, and the non-terminal half needs it (#496)
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
      expect(fired, 'below the record floor a non-terminal home is outside this arm: silent').not.toContain(rekeyDoing);
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
      const parkBorrow = `probe-park-borrow-${tag}`;
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
        // a park whose OWN note was lost (the declared pre-floor crash residual) must not
        // borrow an OLDER auto-blocked note: the park write is 8m, the stale block note
        // 20m, one verdict at 10m — borrowing the block note would fire a legal row
        { id: parkBorrow, pre: null, park: DONE, written: 8 },
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
      await seedRecord(parkBorrow, 'auto-blocked: 1 subtask(s) open', 20);

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
      // ONE verdict only: under a borrow it fires (10m > the stale 20m block note), under
      // the correct fallback it is an all-older round and stays silent — a second, newer
      // verdict would pin the note-loss split wedge (#468's FN class) as 'legal'
      await seedReview(parkBorrow, 'APPROVED', 10);

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
      expect(post, 'a park whose own note is lost must not borrow an older auto-blocked note').not.toContain(
        parkBorrow,
      );
    } finally {
      await sql.end();
    }
  });

  // #491: the CATEGORY TERM. The home's category AT BLOCK TIME splits the LATE re-key
  // (recorded non-terminal while the home resolves terminal now: the status was re-keyed
  // while the task sat blocked, its pending turn superseded by the owner-settled teardown,
  // every verdict older than the note) from the legal #423 settle (recorded category was
  // already terminal) AND from the PRE-BLOCK re-key, which records the terminal category
  // and stays a DECLARED false negative (#491 residual (c)). The block note carries the
  // category from 2.78.41 (HOME-CATEGORY RECORD); the term is floored there, rides the
  // BLOCK half only (the park origin records no category: declared boundary), and a
  // note-less row falls back to the ordering term it always had.
  test('home-category record splits the late re-key from the #423 settle and the pre-block residual (#491)', async () => {
    const below = await $`bash ${script} --strand-sql 2.78.40 2`.nothrow().quiet();
    expect(below.exitCode, below.stderr.toString()).toBe(0);
    expect(below.stdout.toString(), 'the term must not exist below its floor').not.toContain('homeCategory');
    const at = await $`bash ${script} --strand-sql 2.78.41 2`.nothrow().quiet();
    expect(at.exitCode, at.stderr.toString()).toBe(0);
    expect(at.stdout.toString()).toContain("ah.payload->>'homeCategory'");
    expect(at.stdout.toString(), 'the term rides the block half only').not.toContain("mh.body like 'review parked");
    expect(below.stdout.toString(), 'the non-terminal half must not exist below its floor').not.toContain(
      "o.category not in ('done', 'cancelled', 'in_review')",
    );
    expect(at.stdout.toString(), 'the non-terminal half rides the block origin').toContain(
      "o.category not in ('done', 'cancelled', 'in_review')",
    );

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const lateRekey = `probe-homecat-rekey-${tag}`; // FIRES: recorded in_review, resolves done, all-older
      const preBlockRekey = `probe-homecat-settle-${tag}`; // silent: the re-key predates the block, so it records done
      const parkRecorded = `probe-homecat-park-${tag}`; // silent: a TERMINAL park landing keeps the ordering-only scope (#507 term is non-terminal-only)
      const noteLessOld = `probe-homecat-noteless-old-${tag}`; // silent: MIN fallback, verdict older than the stamp
      const noteLessNew = `probe-homecat-noteless-new-${tag}`; // fires: the fallback's own counterexample
      const recordedLive = `probe-homecat-live-${tag}`; // silent: a PENDING row in max(round)
      const recordedDoing = `probe-homecat-doing-${tag}`; // FIRES (#496): recorded in_review, resolves working, all-older
      const holdLanding = `probe-homecat-hold-landing-${tag}`; // silent (#496): the legal hold-landing block records the category it RESOLVES
      const twoEpisode = `probe-homecat-two-episode-${tag}`; // silent: the NEWEST note recorded done
      const undecided = `probe-homecat-undecided-${tag}`; // silent: no verdict row in max(round)
      const terminalRekey = `probe-homecat-terminal-${tag}`; // fires: done -> cancelled re-key while blocked
      const tornRound = `probe-homecat-torn-round-${tag}`; // silent: max(round) holds no verdict

      const seedTask = async (id: string, pre: string | null, park: string | null, writtenMinutesAgo: number) => {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, now(), now() - ($6::int * interval '1 minute'))`,
          [id, id, BLOCKED, pre, park, writtenMinutesAgo],
        );
      };
      const seedRecord = async (id: string, minutesAgo: number, body: string, meta: Record<string, unknown> | null) => {
        const msgId = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, author_id, body, created_at)
           values ($1, $2, null, $3, now() - ($4::int * interval '1 minute'))`,
          [msgId, id, body, minutesAgo],
        );
        await sql.unsafe('insert into task_message_activities (message_id, payload) values ($1, $2)', [
          msgId,
          { kind: 'STATUS', ...(meta ?? {}) },
        ]);
      };
      const seedVerdict = async (id: string, minutesAgo: number, status = 'APPROVED', round = 1) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, $4, $3, null, now() - ($5::int * interval '1 minute'), now() - ($5::int * interval '1 minute'))`,
          [`rev-${crypto.randomUUID()}`, id, status, round, minutesAgo],
        );
      };

      // the strand: the note recorded in_review, the home resolves done, every verdict older
      await seedTask(lateRekey, DONE, null, 5);
      await seedRecord(lateRekey, 5, 'auto-blocked: 1 subtask(s) open', {
        autoBlocked: true,
        open: 1,
        homeCategory: 'in_review',
      });
      await seedVerdict(lateRekey, 10);
      // the legal #423 re-block: the recorded category was ALREADY terminal
      await seedTask(preBlockRekey, DONE, null, 5);
      await seedRecord(preBlockRekey, 5, 'auto-blocked: 1 subtask(s) open', {
        autoBlocked: true,
        open: 1,
        homeCategory: 'done',
      });
      await seedVerdict(preBlockRekey, 10);
      // a TERMINAL park landing keeps the ordering-only scope: even a valid park record
      // with an all-older round is the round's own legal stop, never the #507 term
      await seedTask(parkRecorded, null, DONE, 5);
      await seedRecord(parkRecorded, 5, 'review parked — infra down', { homeCategoryAtPark: 'in_review' });
      await seedVerdict(parkRecorded, 10);
      // a note-less row keeps the ordering-only fallback: older verdict silent, newer fires
      await seedTask(noteLessOld, DONE, null, 5);
      await seedVerdict(noteLessOld, 10);
      await seedTask(noteLessNew, DONE, null, 5);
      await seedVerdict(noteLessNew, 2);
      // the live-round clause still owns the exclusion
      await seedTask(recordedLive, DONE, null, 5);
      await seedRecord(recordedLive, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'in_review' });
      await seedVerdict(recordedLive, 10);
      await seedVerdict(recordedLive, 4, 'PENDING');
      // the record is the NEWEST same-kind note: an older in_review note must not outvote
      // the newest done note (the binding is max(created_at), not "any note")
      await seedTask(twoEpisode, DONE, null, 5);
      await seedRecord(twoEpisode, 30, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'in_review' });
      await seedRecord(twoEpisode, 5, 'auto-blocked: 2 subtask(s) open', { homeCategory: 'done' });
      await seedVerdict(twoEpisode, 40);
      // a terminal -> terminal re-key is the same term: the recorded 'done' is not the
      // category the home carries now ('cancelled')
      await seedTask(terminalRekey, CANCELLED, null, 5);
      await seedRecord(terminalRekey, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'done' });
      await seedVerdict(terminalRekey, 10);
      // the DECIDED round is max(round): a torn-down current round (SUPERSEDED only)
      // over an older decided round must stay silent — the term binds to max(round)
      await seedTask(tornRound, DONE, null, 5);
      await seedRecord(tornRound, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'in_review' });
      await seedVerdict(tornRound, 10);
      await seedVerdict(tornRound, 1, 'SUPERSEDED', 2);
      // a round with NO verdict row is not a decided round: the exists-verdict clause
      await seedTask(undecided, DONE, null, 5);
      await seedRecord(undecided, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'in_review' });
      // a home that still resolves non-terminal IS the shape from 2.78.41 when the record
      // splits it: recorded in_review, resolves working, every verdict older than the note
      await seedTask(recordedDoing, DOING, null, 5);
      await seedRecord(recordedDoing, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'in_review' });
      await seedVerdict(recordedDoing, 10);
      // the LEGAL control: a hold-landing block records the category it RESOLVES, so the
      // recorded-vs-resolved equality is the only thing that silences it
      await seedTask(holdLanding, DOING, null, 5);
      await seedRecord(holdLanding, 5, 'auto-blocked: 1 subtask(s) open', { homeCategory: 'working' });
      await seedVerdict(holdLanding, 10);

      const armOf = async (probeSql: string) => {
        const rows = (await sql.unsafe(probeSql)) as Record<string, unknown>[];
        const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'rekeyhome');
        expect(arm, 'the emitted SQL must carry the re-keyed-home arm').toBeTruthy();
        return new Set(String(arm?.[1] ?? 'none').split(','));
      };

      const pre = await armOf(below.stdout.toString().trim());
      expect(
        pre,
        'below the floor the late re-key records no category and reads as the legal #423 shape',
      ).not.toContain(lateRekey);
      expect(pre, 'the note-less fallback is unchanged below the floor').toContain(noteLessNew);
      expect(pre, 'the non-terminal half is FLOORED: a split non-terminal home cannot fire below it').not.toContain(
        recordedDoing,
      );
      expect(pre, 'the legal hold-landing control is silent on both sides of the floor').not.toContain(holdLanding);

      const post = await armOf(at.stdout.toString().trim());
      expect(post, 'a home re-keyed terminal AFTER the record over an all-older round is the strand').toContain(
        lateRekey,
      );
      expect(
        post,
        'the PRE-BLOCK re-key records the already-terminal category and stays the DECLARED residual (#491(c))',
      ).not.toContain(preBlockRekey);
      expect(post, 'a TERMINAL park landing keeps the ordering-only scope: an all-older round is legal').not.toContain(
        parkRecorded,
      );
      expect(post, 'a note-less row falls back to the ordering term: older verdict stays silent').not.toContain(
        noteLessOld,
      );
      expect(post, 'a note-less row keeps the ordering fallback counterexample').toContain(noteLessNew);
      expect(post, 'a PENDING row in max(round) is a live round, not this strand').not.toContain(recordedLive);
      expect(post, 'a non-terminal home whose recorded category differs is the strand (#496)').toContain(recordedDoing);
      expect(
        post,
        'the legal hold-landing block records the category it resolves: recorded == resolved stays silent (#496)',
      ).not.toContain(holdLanding);
      expect(post, 'the term reads the NEWEST same-kind note, never an older one (residual (b))').not.toContain(
        twoEpisode,
      );
      expect(post, 'a round with no verdict row is not a decided round').not.toContain(undecided);
      expect(post, 'a terminal -> terminal re-key is the same wedge (recorded done, home cancelled now)').toContain(
        terminalRekey,
      );
      expect(post, 'the decided round is max(round): a torn-down current round stays silent').not.toContain(tornRound);
    } finally {
      await sql.end();
    }
  });

  // #507: the PARK-CATEGORY non-terminal half. A DECISION/FINAL park has NO automatic
  // restore, so the RESTORE-STRAND park half never runs for it, and its home re-keyed into
  // a NON-terminal category is read by NO other term (`parkclosed` needs the home to
  // resolve in_review; the re-key arm's park branch needs done/cancelled). The park's
  // `review parked` record carries `homeCategoryAtPark` (`in_review` by construction) from
  // 2.78.43: a recorded category the home no longer carries, under the branch's OWN
  // per-verdict ordering — a verdict NEWER than the park record means the round was LIVE
  // when the park landed and the settle flip the re-key then refused could not land — FIRES.
  // An all-older round is the round's own legal stop; a note WITHOUT the record falls back
  // to the terminal-only scope; a TERMINAL landing keeps the ordering-only scope (a
  // recorded in_review vs a terminal home is the declared legal class, never this term).
  test('park-category record closes the DECISION-park non-terminal re-key (#507)', async () => {
    const below = await $`bash ${script} --strand-sql 2.78.42 2`.nothrow().quiet();
    expect(below.exitCode, below.stderr.toString()).toBe(0);
    expect(below.stdout.toString(), 'the park-category term must not exist below its floor').not.toContain(
      'homeCategoryAtPark',
    );
    const at = await $`bash ${script} --strand-sql 2.78.43 2`.nothrow().quiet();
    expect(at.exitCode, at.stderr.toString()).toBe(0);
    expect(at.stdout.toString()).toContain("ah.payload->>'homeCategoryAtPark'");

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const tag = crypto.randomUUID();
      const late = `probe-parkcat-late-${tag}`; // FIRES: home re-keyed working, verdict NEWER than the park record
      const older = `probe-parkcat-older-${tag}`; // silent: the round closed BEFORE its park — the round's own legal stop
      const noRecord = `probe-parkcat-norecord-${tag}`; // silent: a pre-floor note carries no record — terminal-only fallback
      const equal = `probe-parkcat-equal-${tag}`; // silent: the recorded category EQUALS the one the home carries
      const inReview = `probe-parkcat-inreview-${tag}`; // silent: no re-key (the arm's origin exclusion owns it)
      const live = `probe-parkcat-live-${tag}`; // silent: a PENDING row in max(round)
      const terminalOlder = `probe-parkcat-term-older-${tag}`; // silent: a TERMINAL landing keeps the ordering-only scope
      const terminalLate = `probe-parkcat-term-late-${tag}`; // fires: the terminal landing's own ordering term (unchanged)

      const seedTask = async (id: string, park: string, writtenMinutesAgo: number) => {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
           values ($1, $2, $3, null, $4, now(), now() - ($5::int * interval '1 minute'))`,
          [id, id, BLOCKED, park, writtenMinutesAgo],
        );
      };
      const seedRecord = async (id: string, minutesAgo: number, meta: Record<string, unknown> | null) => {
        const msgId = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, author_id, body, created_at)
           values ($1, $2, null, $3, now() - ($4::int * interval '1 minute'))`,
          [msgId, id, 'review parked — waiting on owner', minutesAgo],
        );
        await sql.unsafe('insert into task_message_activities (message_id, payload) values ($1, $2)', [
          msgId,
          { kind: 'STATUS', ...(meta ?? {}) },
        ]);
      };
      const seedVerdict = async (id: string, minutesAgo: number, status = 'APPROVED', round = 1) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, created_at, decided_at)
           values ($1, $2, $4, $3, null, now() - ($5::int * interval '1 minute'), now() - ($5::int * interval '1 minute'))`,
          [`rev-${crypto.randomUUID()}`, id, status, round, minutesAgo],
        );
      };

      // the strand: DECISION park (no re-arm ladder), home re-keyed working, the settling
      // verdict landed AFTER the park record
      await seedTask(late, DOING, 5);
      await seedRecord(late, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'in_review' });
      await seedVerdict(late, 1);
      // the round's own legal stop: every verdict predates the park record
      await seedTask(older, DOING, 5);
      await seedRecord(older, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'in_review' });
      await seedVerdict(older, 10);
      // a pre-floor park note carries no record: the terminal-only scope is all the row had
      await seedTask(noRecord, DOING, 5);
      await seedRecord(noRecord, 5, { reviewParked: true, fromStatus: IN_REVIEW });
      await seedVerdict(noRecord, 1);
      // the recorded-vs-current EQUALITY is the discriminator: a note recording the category
      // the home carries now must stay silent even with a late verdict
      await seedTask(equal, DOING, 5);
      await seedRecord(equal, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'working' });
      await seedVerdict(equal, 1);
      // no re-key at all: the arm's in_review origin exclusion owns the shape
      await seedTask(inReview, IN_REVIEW, 5);
      await seedRecord(inReview, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'in_review' });
      await seedVerdict(inReview, 1);
      // a live round (PENDING in max(round)) is the ladder-owned shape, never this term
      await seedTask(live, DOING, 5);
      await seedRecord(live, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'in_review' });
      await seedVerdict(live, 10);
      await seedVerdict(live, 1, 'PENDING');
      // a TERMINAL park landing keeps the ordering-only scope: all-older is the legal class
      await seedTask(terminalOlder, DONE, 5);
      await seedRecord(terminalOlder, 5, {
        reviewParked: true,
        fromStatus: IN_REVIEW,
        homeCategoryAtPark: 'in_review',
      });
      await seedVerdict(terminalOlder, 10);
      // ... and its own late-verdict firing is unchanged by this term
      await seedTask(terminalLate, DONE, 5);
      await seedRecord(terminalLate, 5, { reviewParked: true, fromStatus: IN_REVIEW, homeCategoryAtPark: 'in_review' });
      await seedVerdict(terminalLate, 1);

      const armOf = async (probeSql: string) => {
        const rows = (await sql.unsafe(probeSql)) as Record<string, unknown>[];
        const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'rekeyhome');
        expect(arm, 'the emitted SQL must carry the re-keyed-home arm').toBeTruthy();
        return new Set(String(arm?.[1] ?? 'none').split(','));
      };

      const pre = await armOf(below.stdout.toString().trim());
      expect(pre, 'the non-terminal park half is FLOORED: no term below 2.78.43').not.toContain(late);
      expect(pre, 'the terminal landing keeps its pre-floor firing').toContain(terminalLate);

      const post = await armOf(at.stdout.toString().trim());
      expect(
        post,
        'a DECISION park whose park home was re-keyed non-terminal over a late verdict is the strand',
      ).toContain(late);
      expect(
        post,
        "an all-older round under a decision park is the round's own legal stop (the ordering discriminator)",
      ).not.toContain(older);
      expect(post, 'a park note without the record falls back to the terminal-only scope').not.toContain(noRecord);
      expect(post, 'the recorded-vs-current equality keeps a matching-category note silent').not.toContain(equal);
      expect(post, 'a home that still resolves in_review is no re-key').not.toContain(inReview);
      expect(post, 'a PENDING row in max(round) is a live round, not this strand').not.toContain(live);
      expect(post, 'a TERMINAL landing keeps the ordering-only scope: all-older stays legal').not.toContain(
        terminalOlder,
      );
      expect(post, "the terminal landing's own late-verdict term is unchanged").toContain(terminalLate);
    } finally {
      await sql.end();
    }
  });
});
