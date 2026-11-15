import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the DECISION-PARK arm (#431, label `parkclosed`)
// reads the parked round that CLOSED with its settle flip lost: a DECISION-class park
// (park_rearm_after IS NULL with park_rearm_attempts = 0) whose CURRENT round holds no
// PENDING row and at least one VERDICT row, with the round's newest verdict NEWER than the
// PARK's OWN flow record (`review parked …` + kind='STATUS'), the retired `updated_at`
// stamp below the 2.78.38 record floor and for a record-less row.
//
// Nothing else reads the shape: stallrv/lostsettle require a PENDING row,
// settleExtinguishedRound refuses a decided round, the re-arm scan filters
// park_rearm_after IS NOT NULL, restoreUnblocked withholds a FINAL park, and the wedge
// arm excludes every parked row. MAX, not MIN: a multi-reviewer round split across the
// park write is the same owed-flip shape, and the re-key arm's late-row class has no
// analogue here (a park whose home resolves in-review can always land its flip).
//
// Pinned on the SQL that ships: `--strand-sql` emits it and this spec executes exactly
// those bytes against the e2e database, including per-guard mutation proofs — every guard
// is removed once and the row it protects must flip, or the pin pins nothing.

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
  test('fires on a decision park whose round closed with the flip lost, silent on every legal shape', async () => {
    // 2.78.38 = the shipped image; the arm emits at/above its 2.78.37 column floor
    // and only with BOTH origin columns present (a missing column kills the whole UNION)
    const emitted = await $`bash ${script} --strand-sql 2.78.38 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'parkclosed'");
    const oneColumn = await $`bash ${script} --strand-sql 2.78.38 1`.nothrow().quiet();
    expect(oneColumn.exitCode, oneColumn.stderr.toString()).toBe(0);
    expect(oneColumn.stdout.toString(), 'the arm must vanish without the origin columns').not.toContain('parkclosed');
    const oldImage = await $`bash ${script} --strand-sql 2.78.36 2`.nothrow().quiet();
    expect(oldImage.exitCode, oldImage.stderr.toString()).toBe(0);
    expect(oldImage.stdout.toString(), 'the arm must vanish without the referral column').not.toContain('parkclosed');
    const floorImage = await $`bash ${script} --strand-sql 2.78.37 2`.nothrow().quiet();
    expect(floorImage.exitCode, floorImage.stderr.toString()).toBe(0);
    expect(floorImage.stdout.toString(), 'the floor release must emit the arm').toContain('parkclosed');

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
      const parkLost = `probe-park-lost-${tag}`; // fires: THE counterexample (no record — the stamp fallback)
      const parkMasked = `probe-park-masked-${tag}`; // fires: a benign edit after the verdict cannot mask it (record term)
      const parkSplit = `probe-park-split-${tag}`; // fires: a multi-reviewer round split across the park write (MAX)
      const parkRoundScope = `probe-park-round-${tag}`; // fires: the OLDER round's PENDING row does not mean an open round
      const parkKind = `probe-park-kind-${tag}`; // fires: a `review parked` NOTE row is not a flow record (kind gate)
      const parkStaleBlock = `probe-park-staleblock-${tag}`; // fires: an older auto-blocked note must not order this park
      const parkLive = `probe-park-live-${tag}`; // silent: a PENDING row in the current round keeps the round suspended
      const parkVerdictOld = `probe-park-verdictold-${tag}`; // silent: the park landed AFTER the round closed
      const parkRecordNewer = `probe-park-recordnewer-${tag}`; // silent: the park record is newer than every verdict
      const parkRecordEqual = `probe-park-recordequal-${tag}`; // silent: strictly newer, an equal stamp proves nothing
      const parkRearmOwned = `probe-park-rearm-${tag}`; // silent: a ladder-owned park is the re-arm sweep's shape
      const parkExhausted = `probe-park-exhausted-${tag}`; // silent: exhausted parks are the 5b ladder arm's shape
      const parkRekeyed = `probe-park-rekey-${tag}`; // silent: a terminal home is the RE-KEYED-HOME arm's shape
      const parkDangling = `probe-park-dangling-${tag}`; // silent: a deleted home is the ORPHAN-HOME arm's shape
      const parkOnBlock = `probe-park-block-${tag}`; // silent: a gating block is not a park (the wedge arm reads it)
      const parkNotPaused = `probe-park-notpaused-${tag}`; // silent: an in-review row carrying a stale origin
      const parkEmptyRound = `probe-park-empty-${tag}`; // silent: no verdict at all — not a closed round
      const parkReferral = `probe-park-referral-${tag}`; // silent: the referral still owes its vote (#474)
      const parkReferralMet = `probe-park-refmet-${tag}`; // fires: the referral's replacement row landed — no vote owed
      const parkWaiverLate = `probe-park-waiverlate-${tag}`; // fires: a waiver-row park with a LATE verdict is a real strand
      const parkReferralOldRound = `probe-park-refold-${tag}`; // fires: a PREVIOUS round's escalation owes nothing
      const parkVoid = `probe-park-void-${tag}`; // fires: a null-reviewer PENDING row is a NON-VOTE (settleRound's own filter)
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

      // a flow note + its 1:1 activity payload
      const seedNote = async (taskId: string, body: string, kind: string, atMinutes: number) => {
        const id = `msg-${crypto.randomUUID()}`;
        await sql.unsafe(
          `insert into task_messages (id, task_id, body, created_at)
           values ($1, $2, $3, now() - ($4::int * interval '1 minute'))`,
          [id, taskId, body, atMinutes],
        );
        await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [id, { kind }]);
      };
      const parkedNote = (min: number) => `review parked — review turn failed to dispatch (${min}m)`;

      await seedTask({ id: parkLost, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkMasked, status: BLOCKED, park: IN_REVIEW, written: 1 });
      await seedTask({ id: parkSplit, status: BLOCKED, park: IN_REVIEW, written: 5 });
      await seedTask({ id: parkRoundScope, status: BLOCKED, park: IN_REVIEW, written: 30 });
      await seedTask({ id: parkKind, status: BLOCKED, park: IN_REVIEW, written: 20 });
      await seedTask({ id: parkStaleBlock, status: BLOCKED, park: IN_REVIEW, written: 30 });
      await seedTask({ id: parkLive, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkVerdictOld, status: BLOCKED, park: IN_REVIEW, written: 1 });
      await seedTask({ id: parkRecordNewer, status: BLOCKED, park: IN_REVIEW, written: 20 });
      await seedTask({ id: parkRecordEqual, status: BLOCKED, park: IN_REVIEW, written: 30 });
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
      await seedTask({ id: parkEmptyRound, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkReferral, status: BLOCKED, park: IN_REVIEW, written: 20 });
      await seedTask({ id: parkReferralMet, status: BLOCKED, park: IN_REVIEW, written: 20 });
      await seedTask({ id: parkWaiverLate, status: BLOCKED, park: IN_REVIEW, written: 20 });
      await seedTask({ id: parkReferralOldRound, status: BLOCKED, park: IN_REVIEW, written: 30 });
      await seedTask({ id: parkVoid, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkOldRoundVerdict, status: BLOCKED, park: IN_REVIEW, written: 30 });
      await seedTask({ id: parkEscalatedOnly, status: BLOCKED, park: IN_REVIEW, written: 30 });

      // the counterexample: a single-reviewer decision park closed by its approval, 1m ago
      await seedReview(parkLost, 'APPROVED', 1);
      // the MASK case: the park record is 20m old, the verdict 5m, but a benign task edit
      // landed 1m ago — the record term still sees the verdict, the retired stamp does not
      await seedNote(parkMasked, parkedNote(20), 'STATUS', 20);
      await seedReview(parkMasked, 'APPROVED', 5);
      // the split round: reviewer A voted before the park write, reviewer B's vote closed it
      // AFTER — the MAX ordering is what sees the owed flip (a MIN test would call this legal)
      await seedReview(parkSplit, 'APPROVED', 10);
      await seedReview(parkSplit, 'APPROVED', 1);
      // an OLDER round's PENDING row must not read as an open round: round 2 is clean
      await seedReview(parkRoundScope, 'PENDING', null, adminId, 1);
      await seedReview(parkRoundScope, 'APPROVED', 1, adminId, 2);
      // a free-text body that merely starts `review parked` is NOT a flow record: the 1:1
      // payload must carry kind='STATUS' (its NOTE kind leaves the stamp fallback in force)
      await seedNote(parkKind, parkedNote(1), 'NOTE', 1);
      await seedReview(parkKind, 'APPROVED', 10);
      // an older auto-blocked note must never order this park: the arm reads the PARK note
      await seedNote(parkStaleBlock, 'auto-blocked: open children (seeded)', 'STATUS', 10);
      await seedReview(parkStaleBlock, 'APPROVED', 15);
      // a legal parked round is SUSPENDED, not closed: a PENDING voter keeps the arm silent
      await seedReview(parkLive, 'APPROVED', 1);
      await seedReview(parkLive, 'PENDING', null, adminId);
      // the legal "park after settle" shape: the park write is newer than every verdict
      await seedReview(parkVerdictOld, 'APPROVED', 10);
      // the LEGAL waiver park (`referral waived; resolve to resume`): the escalated row is
      // superseded and the park lands over a closed round — the park note is NEWER than
      // the verdict, which is exactly why this arm must stay silent on it
      await seedNote(parkRecordNewer, parkedNote(1), 'STATUS', 1);
      await seedReview(parkRecordNewer, 'APPROVED', 10);
      await seedReview(parkRecordNewer, 'SUPERSEDED', 20, null, 1, adminId);
      // EQUAL stamps prove nothing (strict `>`): the note copies the verdict's exact stamp
      await seedReview(parkRecordEqual, 'APPROVED', 10);
      const equalNote = `msg-${crypto.randomUUID()}`;
      await sql.unsafe(
        `insert into task_messages (id, task_id, body, created_at)
         select $1, $2, $3, decided_at from task_reviews where task_id = $2`,
        [equalNote, parkRecordEqual, parkedNote(10)],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        equalNote,
        { kind: 'STATUS' },
      ]);
      // the referral target never got its row: the round still owes that vote (#474)
      await seedReview(parkReferral, 'APPROVED', 10);
      await seedReview(parkReferral, 'ESCALATED', 20, null, 1, adminId);
      // the replacement row landed: nothing owed, so the closed-round shape is a strand
      await seedReview(parkReferralMet, 'APPROVED', 10, adminId);
      await seedReview(parkReferralMet, 'ESCALATED', 20, null, 1, adminId);
      // a waiver-row park (superseded escalation WITH a target) over which a LATE verdict
      // landed is a real strand: a carve-out keyed on the superseded row would miss it
      await seedNote(parkWaiverLate, parkedNote(10), 'STATUS', 10);
      await seedReview(parkWaiverLate, 'SUPERSEDED', 20, null, 1, adminId);
      await seedReview(parkWaiverLate, 'APPROVED', 1);
      // a PREVIOUS round's escalation owes nothing to THIS round
      await seedReview(parkReferralOldRound, 'ESCALATED', 10, null, 1, adminId);
      await seedReview(parkReferralOldRound, 'APPROVED', 1, null, 2);
      await seedReview(parkRearmOwned, 'APPROVED', 1);
      await seedReview(parkExhausted, 'APPROVED', 1);
      await seedReview(parkRekeyed, 'APPROVED', 1);
      await seedReview(parkDangling, 'APPROVED', 1);
      await seedReview(parkOnBlock, 'APPROVED', 1);
      await seedReview(parkNotPaused, 'APPROVED', 1);
      // a void PENDING row (reviewer deleted mid-round) is a NON-VOTE: the round is closed
      await seedReview(parkVoid, 'APPROVED', 1);
      await seedReview(parkVoid, 'PENDING', null);
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
      for (const fires of [
        parkLost,
        parkMasked,
        parkSplit,
        parkRoundScope,
        parkKind,
        parkStaleBlock,
        parkVoid,
        parkReferralMet,
        parkWaiverLate,
        parkReferralOldRound,
      ]) {
        expect(ids.has(fires), `${fires} must fire`).toBe(true);
      }
      for (const silent of [
        parkLive,
        parkVerdictOld,
        parkRecordNewer,
        parkRecordEqual,
        parkRearmOwned,
        parkExhausted,
        parkRekeyed,
        parkDangling,
        parkOnBlock,
        parkNotPaused,
        parkEmptyRound,
        parkOldRoundVerdict,
        parkEscalatedOnly,
        parkReferral,
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
          name: 'referral round binding',
          sql: armSql.replace(
            "e.round = (select max(r4.round) from task_reviews r4 where r4.task_id = t.id) and e.status = 'ESCALATED'",
            "e.status = 'ESCALATED'",
          ),
          fire: [],
          silent: [parkReferralOldRound],
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
          name: 'live-voter filter',
          sql: armSql.replace(' and r.reviewer_id is not null', ''),
          fire: [],
          silent: [parkVoid],
        },
        {
          name: 'verdict round binding',
          sql: armSql.replace(
            "and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))",
            "and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED'))",
          ),
          fire: [parkOldRoundVerdict],
          silent: [],
        },
        {
          name: 'verdict status list',
          sql: armSql.replace("r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')", "r.status <> 'PENDING'"),
          fire: [parkEscalatedOnly],
          silent: [],
        },
        {
          name: 'paused scope',
          sql: armSql.replace("s.category = 'paused'", "s.category in ('paused', 'in_review')"),
          fire: [parkNotPaused],
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
          name: 'MAX ordering',
          sql: armSql.replace('max(coalesce(r.decided_at, r.created_at))', 'min(coalesce(r.decided_at, r.created_at))'),
          fire: [parkLost],
          silent: [parkSplit],
        },
        {
          name: 'record term',
          sql: armSql.replace(
            /coalesce\(\(select max\(m\.created_at\) from task_messages m where m\.task_id = t\.id and m\.body like 'review parked %' and exists \(select 1 from task_message_activities a where a\.message_id = m\.id and a\.payload->>'kind' = 'STATUS'\)\), t\.updated_at\)/,
            't.updated_at',
          ),
          fire: [],
          silent: [parkMasked],
        },
        {
          name: 'kind gate',
          sql: armSql.replace(" and a.payload->>'kind' = 'STATUS'", ''),
          fire: [],
          silent: [parkKind],
        },
        {
          name: 'strict ordering',
          sql: armSql.replace(') > coalesce((select max(m.created_at)', ') >= coalesce((select max(m.created_at)'),
          fire: [parkRecordEqual],
          silent: [],
        },
        {
          name: 'park-only record',
          sql: armSql.replace(
            "m.body like 'review parked %'",
            "(m.body like 'auto-blocked:%' or m.body like 'review parked %')",
          ),
          fire: [],
          silent: [parkStaleBlock],
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
