import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the DECISION-PARK arm (#431, label `parkclosed`)
// reads a DECISION-class park (park_rearm_after IS NULL with park_rearm_attempts = 0)
// whose CURRENT round is CLOSED while the park still stands. That combination has NO
// legal writer: every settle flips the task out of the paused category and clears both
// origins in the same statement, and every park of an already-closed round is itself the
// strand. Both crash orders land here — a verdict written before the flip (a late AI
// verdict on the parked task; the human verbs refuse a non-in_review task) and a park
// written after a crashed flip (its note NEWER than the verdict) — so the arm keys on the
// SHAPE, never an ordering (an ordering term would hide the park-after-crash order).
//
// CLOSED mirrors settleRound's own view: no LIVE PENDING voter (a NULL-reviewer void row
// is a non-vote), no owed referral (an ESCALATED row whose target never got a replacement
// row still owes that vote, #474), and at least one VERDICT row. Nothing else reads the
// shape: stallrv/lostsettle need a live PENDING row, settleExtinguishedRound refuses at
// its in-in_review-category gate, the re-arm scan filters park_rearm_after IS NOT NULL,
// restoreUnblocked withholds a FINAL park, and the wedge arm excludes every parked row.
//
// Pinned on the SQL that ships (`--strand-sql`), with per-guard mutation proofs: each
// guard is removed once and the rows it protects must flip, or the pin pins nothing.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const CANCELLED = '01a14743-43f5-759d-a00e-b0f2a5a04f4c';
/** a canonical uuid that names no task_statuses row — a DELETED home, the orphan arm's shape */
const DANGLING = '01a14743-dead-7e57-8000-000000000001';

test.describe('prod probe decision-park arm (#431)', () => {
  test('fires on a decision park over a closed round, silent on every legal shape', async () => {
    // 2.78.38 = the shipped image; the arm emits at/above its 2.63.0 re-arm-column floor
    // and only with BOTH origin columns present (a missing column kills the whole UNION)
    const emitted = await $`bash ${script} --strand-sql 2.78.38 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'parkclosed'");
    const oneColumn = await $`bash ${script} --strand-sql 2.78.38 1`.nothrow().quiet();
    expect(oneColumn.exitCode, oneColumn.stderr.toString()).toBe(0);
    expect(oneColumn.stdout.toString(), 'the arm must vanish without the origin columns').not.toContain('parkclosed');
    const oldImage = await $`bash ${script} --strand-sql 2.62.9 2`.nothrow().quiet();
    expect(oldImage.exitCode, oldImage.stderr.toString()).toBe(0);
    expect(oldImage.stdout.toString(), 'the arm must vanish without the re-arm columns').not.toContain('parkclosed');

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      const adminId = String((await sql.unsafe('select id from "user" order by created_at limit 1'))[0]?.id ?? '');
      expect(adminId, 'the e2e boot admin must exist for a live-reviewer seed').not.toBe('');

      for (const seed of [DOING, DONE, IN_REVIEW, BLOCKED, CANCELLED]) {
        const home = await sql.unsafe('select id from task_statuses where id = $1', [seed]);
        expect(home.length, `seed status ${seed} must exist in the e2e boot rows`).toBe(1);
      }

      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const tag = crypto.randomUUID();
      const parkLost = `probe-park-lost-${tag}`; // fires: the verdict-before-the-flip crash
      const parkMirror = `probe-park-mirror-${tag}`; // fires: the park-after-crashed-flip order (note NEWER than the verdict)
      const parkSplit = `probe-park-split-${tag}`; // fires: a multi-reviewer round split across the park write
      const parkRoundScope = `probe-park-round-${tag}`; // fires: an OLDER round's PENDING row does not keep this round open
      const parkVoid = `probe-park-void-${tag}`; // fires: a null-reviewer PENDING row is a NON-VOTE (settleRound's filter)
      const parkTombstone = `probe-park-tombstone-${tag}`; // fires: an ESCALATED row with a NULL target owes no vote
      const parkReferralMet = `probe-park-refmet-${tag}`; // fires: the referral's replacement row landed — no vote owed
      const parkLive = `probe-park-live-${tag}`; // silent: a live PENDING voter keeps the round open
      const parkReferral = `probe-park-referral-${tag}`; // silent: the referral still owes its vote (#474)
      const parkRearmOwned = `probe-park-rearm-${tag}`; // silent: a ladder-owned park is the re-arm sweep's shape
      const parkExhausted = `probe-park-exhausted-${tag}`; // silent: exhausted parks are the 5b ladder arm's shape
      const parkRekeyed = `probe-park-rekey-${tag}`; // silent: a terminal home is the RE-KEYED-HOME arm's shape
      const parkDangling = `probe-park-dangling-${tag}`; // silent: a deleted home is the ORPHAN-HOME arm's shape
      const parkOnBlock = `probe-park-block-${tag}`; // silent: a gating block is not a park (the wedge arm reads it)
      const parkNotPaused = `probe-park-notpaused-${tag}`; // silent: an in-review row carrying a stale origin
      const parkEmptyRound = `probe-park-empty-${tag}`; // silent: no verdict at all — not a closed round
      const parkOldRoundVerdict = `probe-park-oldround-${tag}`; // silent: a verdict in an OLDER round is not this round's
      const parkEscalatedOnly = `probe-park-escalated-${tag}`; // silent: ESCALATED is not a verdict

      const seedTask = async (t: {
        id: string;
        status: string;
        pre?: string | null;
        park?: string | null;
        written: number;
        attempts?: number;
        rearmInMinutes?: number | null;
      }) => {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status,
                              park_rearm_attempts, park_rearm_after, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6,
                   case when $7::int is null then null else now() + ($7::int * interval '1 minute') end,
                   now(), now() - ($8::int * interval '1 minute'))`,
          [t.id, t.id, t.status, t.pre ?? null, t.park ?? null, t.attempts ?? 0, t.rearmInMinutes ?? null, t.written],
        );
      };

      // decidedMinutesAgo = null seeds a still-PENDING row (a live round)
      const seedReview = async (
        taskId: string,
        status: string,
        decidedMinutesAgo: number | null,
        reviewerId: string | null = null,
        round = 1,
        referralTargetId: string | null = null,
      ) => {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, round, status, reviewer_id, referral_target_id, created_at, decided_at)
           values ($1, $2, $3, $4, $5, $6, now() - interval '30 minutes',
                   case when $7::int is null then null else now() - ($7::int * interval '1 minute') end)`,
          [`rev-${crypto.randomUUID()}`, taskId, round, status, reviewerId, referralTargetId, decidedMinutesAgo],
        );
      };

      // a flow note + its 1:1 activity payload (jsonb params must be OBJECTS: a
      // JSON.stringify string casts to a jsonb scalar and `->>'kind'` reads NULL)
      const seedNote = async (taskId: string, body: string, kind: string, atMinutes: number) => {
        const id = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, body, created_at)
           values ($1, $2, $3, now() - ($4::int * interval '1 minute'))`,
          [id, taskId, body, atMinutes],
        );
        await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [id, { kind }]);
      };

      for (const id of [
        parkLost,
        parkMirror,
        parkSplit,
        parkRoundScope,
        parkVoid,
        parkTombstone,
        parkReferralMet,
        parkLive,
        parkReferral,
        parkEmptyRound,
        parkOldRoundVerdict,
        parkEscalatedOnly,
      ]) {
        await seedTask({ id, status: BLOCKED, park: IN_REVIEW, written: 10 });
      }
      await seedTask({
        id: parkRearmOwned,
        status: BLOCKED,
        park: IN_REVIEW,
        written: 10,
        attempts: 1,
        rearmInMinutes: 5,
      });
      await seedTask({ id: parkExhausted, status: BLOCKED, park: IN_REVIEW, written: 10, attempts: 5 });
      await seedTask({ id: parkRekeyed, status: BLOCKED, park: DONE, written: 10 });
      await seedTask({ id: parkDangling, status: BLOCKED, park: DANGLING, written: 10 });
      await seedTask({ id: parkOnBlock, status: BLOCKED, pre: IN_REVIEW, written: 10 });
      await seedTask({ id: parkNotPaused, status: IN_REVIEW, park: IN_REVIEW, written: 10 });

      // verdict-before-the-flip: the late AI verdict closed the round on a parked task
      await seedReview(parkLost, 'APPROVED', 1);
      // park-after-crashed-flip: the park note is NEWER than the verdict — same strand
      await seedNote(parkMirror, 'review parked — review turn failed to dispatch (1m)', 'STATUS', 1);
      await seedReview(parkMirror, 'APPROVED', 10);
      // the split round: reviewer A voted before the park write, reviewer B's vote closed it
      await seedReview(parkSplit, 'APPROVED', 10);
      await seedReview(parkSplit, 'APPROVED', 1);
      // an OLDER round's PENDING row must not read as an open round: round 2 is clean
      await seedReview(parkRoundScope, 'PENDING', null, adminId, 1);
      await seedReview(parkRoundScope, 'APPROVED', 1, adminId, 2);
      // a void PENDING row (reviewer deleted mid-round) is a NON-VOTE
      await seedReview(parkVoid, 'APPROVED', 1);
      await seedReview(parkVoid, 'PENDING', null);
      // an ESCALATED tombstone (target deleted, referral_target_id NULL) owes nothing
      await seedReview(parkTombstone, 'APPROVED', 1);
      await seedReview(parkTombstone, 'ESCALATED', 1);
      // the referral's replacement row landed: the vote is no longer owed
      await seedReview(parkReferralMet, 'APPROVED', 1, adminId);
      await seedReview(parkReferralMet, 'ESCALATED', 10, null, 1, adminId);
      // a legal parked round is SUSPENDED, not closed: a live voter keeps the arm silent
      await seedReview(parkLive, 'APPROVED', 1);
      await seedReview(parkLive, 'PENDING', null, adminId);
      // the referral target never got its row: the round still owes that vote (#474)
      await seedReview(parkReferral, 'APPROVED', 1);
      await seedReview(parkReferral, 'ESCALATED', 10, null, 1, adminId);
      await seedReview(parkRearmOwned, 'APPROVED', 1);
      await seedReview(parkExhausted, 'APPROVED', 1);
      await seedReview(parkRekeyed, 'APPROVED', 1);
      await seedReview(parkDangling, 'APPROVED', 1);
      await seedReview(parkOnBlock, 'APPROVED', 1);
      await seedReview(parkNotPaused, 'APPROVED', 1);
      // a verdict in an OLDER round is not THIS round's closure
      await seedReview(parkOldRoundVerdict, 'APPROVED', 1, adminId, 1);
      await seedReview(parkOldRoundVerdict, 'SUPERSEDED', 1, adminId, 2);
      // ESCALATED is a non-vote: a round holding only escalations has no verdict
      await seedReview(parkEscalatedOnly, 'ESCALATED', 1);

      const OUT = new SQL(E2E_DATABASE_URL, { max: 1 });
      // the arm's own bytes, sliced out of the shipped UNION: the mutation proofs below
      // must hit THIS arm, and a whole-SQL replace would hit the first sibling instead
      const armSql = strandSql.slice(strandSql.indexOf("select 'parkclosed'"));
      expect(armSql.startsWith("select 'parkclosed'"), 'the arm slice must start at its emission').toBe(true);
      const runArm = async (query: string) => {
        const rows = (await OUT.unsafe(query)) as Record<string, string>[];
        const row = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'parkclosed');
        return new Set(
          String(row?.[1] ?? 'none')
            .split(',')
            .filter(Boolean),
        );
      };

      const ids = await runArm(armSql);
      for (const fires of [parkLost, parkMirror, parkSplit, parkRoundScope, parkVoid, parkTombstone, parkReferralMet]) {
        expect(ids.has(fires), `${fires} must fire`).toBe(true);
      }
      for (const silent of [
        parkLive,
        parkReferral,
        parkRearmOwned,
        parkExhausted,
        parkRekeyed,
        parkDangling,
        parkOnBlock,
        parkNotPaused,
        parkEmptyRound,
        parkOldRoundVerdict,
        parkEscalatedOnly,
      ]) {
        expect(ids.has(silent), `${silent} must stay silent`).toBe(false);
      }

      // MUTATION PROOFS — each guard removed once; the rows that guard protects must flip
      // (a mutant that only re-fires a row already firing pins nothing)
      const mutants: { name: string; sql: string; fire: string[]; silent: string[] }[] = [
        {
          name: 'live-round clause',
          sql: armSql.replace(
            "and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and ",
            'and ',
          ),
          fire: [parkLive],
          silent: [],
        },
        {
          name: 'round binding',
          sql: armSql.replace(
            "r.status = 'PENDING' and r.reviewer_id is not null and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)",
            "r.status = 'PENDING' and r.reviewer_id is not null",
          ),
          fire: [],
          silent: [parkRoundScope],
        },
        {
          name: 'live-voter filter',
          sql: armSql.replace(' and r.reviewer_id is not null', ''),
          fire: [],
          silent: [parkVoid],
        },
        {
          name: 'referral-owed clause',
          sql: armSql.replace(
            /and not exists \(select 1 from task_reviews e where e\.task_id = t\.id and e\.round = \(select max\(r4\.round\) from task_reviews r4 where r4\.task_id = t\.id\) and e\.status = 'ESCALATED' and e\.referral_target_id is not null and not exists \(select 1 from task_reviews x where x\.task_id = t\.id and x\.round = e\.round and x\.reviewer_id = e\.referral_target_id\)\)/,
            '',
          ),
          fire: [parkReferral],
          silent: [],
        },
        {
          name: 'referral replacement-row term',
          sql: armSql.replace(
            / and not exists \(select 1 from task_reviews x where x\.task_id = t\.id and x\.round = e\.round and x\.reviewer_id = e\.referral_target_id\)/,
            '',
          ),
          fire: [],
          silent: [parkReferralMet],
        },
        {
          name: 're-arm exclusivity',
          sql: armSql.replace('and t.park_rearm_after is null and t.park_rearm_attempts = 0', ''),
          fire: [parkRearmOwned, parkExhausted],
          silent: [],
        },
        {
          name: 'attempts term',
          sql: armSql.replace('t.park_rearm_attempts = 0', 't.park_rearm_attempts >= 0'),
          fire: [parkExhausted],
          silent: [],
        },
        {
          name: 'in-review home resolution',
          sql: armSql.replace(
            "and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category = 'in_review')",
            '',
          ),
          fire: [parkRekeyed, parkDangling],
          silent: [],
        },
        {
          name: 'verdict status list',
          sql: armSql.replace("v.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')", "v.status <> 'PENDING'"),
          fire: [parkEscalatedOnly],
          silent: [],
        },
        {
          name: 'verdict round binding',
          sql: armSql.replace(
            "v.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and v.round = (select max(r5.round) from task_reviews r5 where r5.task_id = t.id)",
            "v.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')",
          ),
          fire: [parkOldRoundVerdict],
          silent: [],
        },
        {
          name: 'verdict presence clause',
          sql: armSql.replace(
            / and exists \(select 1 from task_reviews v where v\.task_id = t\.id and v\.status in \('APPROVED', 'CHANGE_REQUESTED', 'REJECTED'\) and v\.round = \(select max\(r5\.round\) from task_reviews r5 where r5\.task_id = t\.id\)\)/,
            '',
          ),
          fire: [parkEmptyRound],
          silent: [],
        },
        {
          name: 'paused scope',
          sql: armSql.replace("s.category = 'paused'", "s.category in ('paused', 'in_review')"),
          fire: [parkNotPaused],
          silent: [],
        },
      ];
      for (const m of mutants) {
        expect(m.sql, `the ${m.name} mutation must actually change the shipped SQL`).not.toBe(armSql);
        const mutant = await runArm(m.sql);
        for (const id of m.fire) expect(mutant.has(id), `removing the ${m.name} must fire ${id}`).toBe(true);
        for (const id of m.silent) expect(mutant.has(id), `removing the ${m.name} must lose ${id}`).toBe(false);
      }
    } finally {
      await sql.close();
    }
  });
});
