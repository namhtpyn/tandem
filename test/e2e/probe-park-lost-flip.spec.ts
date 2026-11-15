import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the FINAL-PARK arm (#431) reads the lost-flip
// sibling of the parked round: a DECISION-class park (park_rearm_after IS NULL with
// park_rearm_attempts = 0) whose CURRENT round CLOSED after the park write. The park is
// the round's own stop: the owner resolves it by approving, `settleRound` -> `flipTask`
// accepts a paused row whose park_from_status resolves in-review, and a crash between the
// verdict row and the flip leaves the task BLOCKED with the park standing and a closed
// round. Nothing else reads it: stallrv/lostsettle require a PENDING row,
// settleExtinguishedRound refuses a decided round, the re-arm scan filters
// park_rearm_after IS NOT NULL, restoreUnblocked withholds a FINAL park, and the wedge
// arm excludes every parked row. The arm is version-independent as an ARM but
// COLUMN-gated (both origin columns plus the pre-2.62.6 re-arm columns) and its ORDERING
// term is the #466 record-vs-verdict discriminator at 2.78.38, the retired stamp below.
// MAX, not MIN: a multi-reviewer round split across the park write (a vote before, the
// closing vote after) is the same owed-flip shape, and unlike the re-key arm there is no
// late-row class (a park whose home resolves in-review can always land its flip).
// Pinned on the SQL that ships: `--strand-sql` emits it and this spec executes exactly
// those bytes against the e2e database.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const CANCELLED = '01a14743-43f5-759d-a00e-b0f2a5a04f4c';
/** a canonical uuid that names no task_statuses row — a DELETED home, the orphan arm's shape */
const DANGLING = '01a14743-dead-7e57-8000-000000000001';

test.describe('prod probe final-park arm (#431)', () => {
  test('fires on a final park whose round closed with the flip lost, silent on every legal shape', async () => {
    // 2.78.38 = the shipped image; the arm emits at/above the pre-2.62.6 re-arm floor and
    // only with BOTH origin columns present (one missing column kills the whole UNION)
    const emitted = await $`bash ${script} --strand-sql 2.78.38 2`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const strandSql = emitted.stdout.toString().trim();
    expect(strandSql).toContain("select 'parkclosed'");
    const oneColumn = await $`bash ${script} --strand-sql 2.78.38 1`.nothrow().quiet();
    expect(oneColumn.exitCode, oneColumn.stderr.toString()).toBe(0);
    expect(oneColumn.stdout.toString(), 'the arm must vanish without the origin columns').not.toContain('parkclosed');
    const oldImage = await $`bash ${script} --strand-sql 2.62.5 2`.nothrow().quiet();
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
      const parkLost = `probe-park-lost-${tag}`; // fires: THE counterexample — decision park, round closed after it
      const parkSplit = `probe-park-split-${tag}`; // fires: a multi-reviewer round split across the park write
      const parkLive = `probe-park-live-${tag}`; // silent: a PENDING row in the current round keeps the round suspended
      const parkVerdictOld = `probe-park-verdictold-${tag}`; // silent: the park landed AFTER the round closed
      const parkRearmOwned = `probe-park-rearm-${tag}`; // silent: a ladder-owned park is the re-arm sweep's shape
      const parkExhausted = `probe-park-exhausted-${tag}`; // silent: exhausted parks are the 5b ladder arm's shape
      const parkRekeyed = `probe-park-rekey-${tag}`; // silent: a terminal home is the RE-KEYED-HOME arm's shape
      const parkDangling = `probe-park-dangling-${tag}`; // silent: a deleted home is the ORPHAN-HOME arm's shape
      const parkOnBlock = `probe-park-block-${tag}`; // silent: a gating block is not a park (the wedge arm reads it)
      const parkNotPaused = `probe-park-notpaused-${tag}`; // silent: an in-review row carrying a stale origin
      const parkEmptyRound = `probe-park-empty-${tag}`; // silent: no verdict at all — not a closed round

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

      await seedTask({ id: parkLost, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkSplit, status: BLOCKED, park: IN_REVIEW, written: 5 });
      await seedTask({ id: parkLive, status: BLOCKED, park: IN_REVIEW, written: 10 });
      await seedTask({ id: parkVerdictOld, status: BLOCKED, park: IN_REVIEW, written: 1 });
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

      // the counterexample: a single-reviewer decision park closed by its approval, 1m ago
      await seedReview(parkLost, 'APPROVED', 1);
      // the split round: reviewer A voted before the park write, reviewer B's vote closed it
      // AFTER — the MAX ordering is what sees the owed flip (a MIN test would call this legal)
      await seedReview(parkSplit, 'APPROVED', 10);
      await seedReview(parkSplit, 'APPROVED', 1);
      // a legal parked round is SUSPENDED, not closed: a PENDING voter keeps the arm silent
      await seedReview(parkLive, 'APPROVED', 1);
      await seedReview(parkLive, 'PENDING', null, adminId);
      // the legal "park after settle" shape: the park write is newer than every verdict
      await seedReview(parkVerdictOld, 'APPROVED', 10);
      await seedReview(parkRearmOwned, 'APPROVED', 1);
      await seedReview(parkExhausted, 'APPROVED', 1);
      await seedReview(parkRekeyed, 'APPROVED', 1);
      await seedReview(parkDangling, 'APPROVED', 1);
      await seedReview(parkOnBlock, 'APPROVED', 1);
      await seedReview(parkNotPaused, 'APPROVED', 1);

      const OUT = new SQL(E2E_DATABASE_URL, { max: 1 });
      // the arm's own bytes, sliced out of the shipped UNION: the mutation proofs below
      // must hit THIS arm, and a whole-SQL replace would hit the first sibling instead
      const armSql = strandSql.slice(strandSql.indexOf("select 'parkclosed'"));
      expect(armSql.startsWith("select 'parkclosed'"), 'the arm slice must start at its emission').toBe(true);
      const runArm = async (query: string) => {
        const rows = (await OUT.unsafe(query)) as Record<string, string>[];
        const row = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'parkclosed');
        return String(row?.[1] ?? 'none');
      };
      const fires = async () => {
        const ids = (await runArm(armSql)).split(',').filter(Boolean);
        return new Set(ids);
      };

      // the counterexample FIRES
      let ids = await fires();
      expect(ids.has(parkLost), 'a decision park closed after the park write must fire').toBe(true);
      // the multi-reviewer split FIRES (MAX ordering): the round closed after the park
      expect(ids.has(parkSplit), 'a round split across the park write must fire').toBe(true);
      // and every legal / other-arm shape stays silent
      for (const silent of [
        parkLive,
        parkVerdictOld,
        parkRearmOwned,
        parkExhausted,
        parkRekeyed,
        parkDangling,
        parkOnBlock,
        parkNotPaused,
        parkEmptyRound,
      ]) {
        expect(ids.has(silent), `${silent} must stay silent`).toBe(false);
      }

      // MUTATION PROOFS — each guard removal must turn the counterexample red, or the pin
      // pins nothing: (1) drop the closed-round (PENDING) clause -> the live park fires;
      // (2) drop the re-arm exclusivity -> the ladder-owned park fires;
      // (3) drop the in-review home resolution -> the terminal/dangling parks fire;
      // (4) flip MAX to MIN -> the split round disappears.
      const mutants: [string, string, string][] = [
        [
          'live-round clause',
          armSql,
          armSql.replace(
            "and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and (select max(coalesce(r.decided_at, r.created_at))",
            'and (select max(coalesce(r.decided_at, r.created_at))',
          ),
        ],
        [
          're-arm exclusivity',
          armSql,
          armSql.replace('and t.park_rearm_after is null and t.park_rearm_attempts = 0', ''),
        ],
        [
          'in-review home resolution',
          armSql,
          armSql.replace(
            "and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category = 'in_review')",
            '',
          ),
        ],
        [
          'MAX ordering',
          armSql,
          armSql.replace('max(coalesce(r.decided_at, r.created_at))', 'min(coalesce(r.decided_at, r.created_at))'),
        ],
      ];
      for (const [name, before, after] of mutants) {
        expect(after, `the ${name} mutation must actually change the shipped SQL`).not.toBe(before);
        const mutantIds = new Set(
          String(
            (((await OUT.unsafe(after)) as Record<string, string>[])
              .map((r) => Object.values(r) as string[])
              .find((v) => v[0] === 'parkclosed') ?? [undefined, 'none'])[1],
          )
            .split(',')
            .filter(Boolean),
        );
        if (name === 'MAX ordering') {
          expect(mutantIds.has(parkSplit), 'MIN must lose the split round — the reason MAX ships').toBe(false);
        } else {
          expect(mutantIds.has(parkLost), `removing the ${name} must fire the counterexample`).toBe(true);
        }
      }
    } finally {
      await sql.close();
    }
  });
});
