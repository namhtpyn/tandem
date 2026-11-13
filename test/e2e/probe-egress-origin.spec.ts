import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the EGRESS-ORIGIN arm (#427) reads the shape
// every legal egress from a block must leave behind: a task whose status category is NOT
// `paused` while it still carries a gating origin (pre_block_status / park_from_status).
// After 2.78.25 no legal write path produces it — the two settle flips, the owner's manual
// move, abandon's cancel, the note-dispatch bounce and the liveness bounce all clear both
// origins in the SAME statement that lands the status — and no gating arm heals such a
// row: every discriminator resolves those columns on a paused row only, so the next
// auto-block overwrites the home and a later park inherits a home it never recorded.
//
// Keyed on the ORIGINS alone, never the ledger: the block's own resume legally leaves the
// attempt ledger on a live row (#211 bounded cycles), so a ledger term would alert on a
// healthy row — the restored-ladder control below pins exactly that.
//
// The detector is pinned by the SQL that ships: the probe emits it (--egress-sql) and this
// spec executes exactly those bytes against the e2e database — no test-side copy.

const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const DOING = '01a14743-43f5-759d-a00e-9ccda502cc88';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const CANCELLED = '01a14743-43f5-759d-a00e-b0f2a5a04f4c';

test.describe('prod probe egress-origin arm (#427)', () => {
  test('fires on a non-paused row carrying an origin, silent on every legal shape', async () => {
    const emitted = await $`bash ${script} --egress-sql`.nothrow().quiet();
    expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
    const egressSql = emitted.stdout.toString().trim();
    expect(egressSql).toContain("select 'egressorigin'");
    expect(egressSql).toContain("s.category <> 'paused'");

    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    try {
      // ids per run: the e2e DB persists across runs and the cleanup sweep is time-windowed
      const parkLeak = `probe-egress-park-${crypto.randomUUID()}`; // fires: cancel left a park home
      const gateLeak = `probe-egress-gate-${crypto.randomUUID()}`; // fires: bounce left a gate home
      const doneGateLeak = `probe-egress-done-${crypto.randomUUID()}`; // fires: terminal row kept a home
      const legalPark = `probe-egress-legalpark-${crypto.randomUUID()}`; // legal: a park standing on BLOCKED
      const legalGate = `probe-egress-legalgate-${crypto.randomUUID()}`; // legal: a gating auto-block
      const restoredLadder = `probe-egress-ladder-${crypto.randomUUID()}`; // legal: resumed park keeps its ledger
      const cleanReview = `probe-egress-clean-${crypto.randomUUID()}`; // legal: nothing recorded

      const seedTasks: Array<{
        id: string;
        status: string;
        pre: string | null;
        park: string | null;
        attempts: number;
        rearm: boolean;
      }> = [
        // THE SHAPE: a task that left a block and kept the home. Two origins, two egresses
        // (park today, gate after a child-restore) — the arm keys on the union.
        { id: parkLeak, status: IN_REVIEW, pre: null, park: IN_REVIEW, attempts: 3, rearm: true },
        { id: gateLeak, status: TODO, pre: IN_REVIEW, park: null, attempts: 0, rearm: false },
        { id: doneGateLeak, status: CANCELLED, pre: IN_REVIEW, park: null, attempts: 0, rearm: false },
        // LEGAL: a block standing on BLOCKED may carry either home — that is what the home is for
        { id: legalPark, status: BLOCKED, pre: null, park: IN_REVIEW, attempts: 2, rearm: true },
        { id: legalGate, status: BLOCKED, pre: IN_REVIEW, park: null, attempts: 0, rearm: false },
        // LEGAL: the block's own RESUME keeps the attempt ledger off the block — #211's
        // bounded re-fire cycle. A ledger term in the arm would alert on this healthy row.
        { id: restoredLadder, status: DOING, pre: null, park: null, attempts: 4, rearm: true },
        { id: cleanReview, status: IN_REVIEW, pre: null, park: null, attempts: 0, rearm: false },
      ];
      for (const t of seedTasks) {
        await sql.unsafe(
          `insert into tasks (id, title, status, pre_block_status, park_from_status,
                              park_rearm_attempts, park_rearm_after, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, case when $7::boolean then now() + interval '1 hour' else null end, now(), now())`,
          [t.id, t.id, t.status, t.pre, t.park, t.attempts, t.rearm],
        );
      }

      const rows = await sql.unsafe(egressSql);
      // the label column is unnamed in the union shape: key on the arm's own tag, never an alias
      const arm = rows.map((r) => Object.values(r) as string[]).find((v) => v[0] === 'egressorigin');
      expect(arm, 'the emitted SQL must carry the egress-origin arm').toBeTruthy();
      const fired = new Set(String(arm?.[1] ?? 'none').split(','));

      // the illegal shapes — the arm's whole point
      expect(fired, 'a row that left a park and kept park_from_status is the #427 shape').toContain(parkLeak);
      expect(fired, 'a row that left a gating block and kept pre_block_status is the #427 shape').toContain(gateLeak);
      expect(fired, 'a terminal row that kept a gate home is the same leak').toContain(doneGateLeak);

      // legal controls — a false alarm here is a standing-fault ping (anti-noise law)
      expect(fired, 'a park STANDING on BLOCKED legally carries its home').not.toContain(legalPark);
      expect(fired, 'a gating auto-block legally carries pre_block_status').not.toContain(legalGate);
      expect(
        fired,
        'a RESUMED park legally keeps its attempt ledger off the block (#211) — a ledger term would be a false alarm',
      ).not.toContain(restoredLadder);
      expect(fired, 'a row with nothing recorded is clean').not.toContain(cleanReview);
    } finally {
      await sql.close();
    }
  });
});
