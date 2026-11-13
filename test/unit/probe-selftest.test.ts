import { existsSync } from 'node:fs';

import { $ } from 'bun';
import { describe, expect, it } from 'vitest';

// Contract: SPEC.md "Probe versioning" — the probe's pure detectors are
// self-asserted before any network/SSH call (epoch-ms stamps, health word,
// so the detector can be checked in CI without a prod target).
const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

describe('prod probe selfcheck', () => {
  it('passes pure-logic assertions with zero network', async () => {
    const proc = $`bash ${script} --selfcheck`.nothrow().quiet();
    const { exitCode, stdout, stderr } = await proc;
    expect(exitCode, stderr.toString()).toBe(0);
    expect(stdout.toString()).toContain('ok probe selfcheck');
  });

  // #424: the dead-round wedge arm widens to a gating block whose round is closed. The
  // regression test for the detector executes the emitted SQL against a real database
  // (test/e2e/probe-wedge-block.spec.ts); this pins the GATE that decides whether those
  // bytes carry the branch at all — dropping it (or ungating it) must go red here first.
  it('emits the strand SQL with the block branch gated on version AND origin columns', async () => {
    // The WEDGE arm alone: `park_from_status` also rides the ownership predicate echoed
    // by the stallrv/lostsettle arms, so a whole-SQL grep stays green with the wedge
    // branch deleted (r1 review, P3).
    const wedgeOf = async (ver: string, cols: string) => {
      const proc = await $`bash ${script} --strand-sql ${ver} ${cols}`.nothrow().quiet();
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      return proc.stdout.toString().split(" union all select 'strand'")[0] ?? '';
    };

    const wedge = await wedgeOf('2.78.24', '2');
    expect(wedge).toContain("select 'wedge'");
    expect(wedge).toContain("s.category = 'in_review'");
    expect(wedge).toContain('park_from_status is null');
    expect(wedge).toContain("r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')");
    // both branches carry the #430 owner-status discriminator (a `status: …` activity
    // row whose payload kind is STATUS, newer than the round's newest verdict), and the
    // retired updated_at ordering is GONE: a reintroduced term would silently restore the mask
    expect(wedge.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(2);
    expect(wedge.match(/a\.payload->>'kind' = 'STATUS'/g) ?? []).toHaveLength(2);
    // the FULL clause, including the round binding the old pin used to cover (dropping
    // just the binding reintroduces a legal-state false positive)
    expect(
      wedge.match(
        /and r\.status in \('APPROVED', 'CHANGE_REQUESTED', 'REJECTED'\) and r\.round = \(select max\(r3\.round\) from task_reviews r3 where r3\.task_id = t\.id\)\)\)/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(wedge).not.toContain('t.updated_at');

    // #430 floor: BELOW the atomic-writer release the owner clause must not appear — an
    // old image can lose a manual move's record, so it keeps the verdict-vs-write rule
    const pre = await wedgeOf('2.78.23', '2');
    expect(pre).toContain("select 'wedge'");
    expect(pre.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(0);
    expect(pre.match(/\) > t\.updated_at/g) ?? []).toHaveLength(2);

    // a pre-block image cannot heal the shape: the branch must not exist in its SQL
    const below = await wedgeOf('2.78.19', '2');
    expect(below).toContain("select 'wedge'");
    expect(below).not.toContain('park_from_status');
    expect(below.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(0);
    expect(below.match(/\) > t\.updated_at/g) ?? []).toHaveLength(1);

    const noColumns = await wedgeOf('2.78.20', '1');
    expect(noColumns).not.toContain('park_from_status');
  });

  // #427: the egress-origin arm. Same discipline as the wedge arm — the detector is
  // pinned by the bytes that ship (`--egress-sql`), never a test-side copy. The arm's
  // regression beyond the byte pins (a seeded DB) lives in the probe's live validation;
  // here every clause a mutation could silently drop is asserted, so flipping the scope,
  // dropping an origin term or reintroducing a mutable-stamp/ledger term goes red.
  it('emits the egress-origin arm: non-paused scope, both origin terms, no stamp/ledger term', async () => {
    const proc = await $`bash ${script} --egress-sql`.nothrow().quiet();
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const sql = proc.stdout.toString();
    expect(sql).toContain("select 'egressorigin'");
    // the scope: a row OUTSIDE the paused category — inverting this to `=` alerts on every
    // healthy BLOCKED task, dropping the negations ships a dead arm
    expect(sql).toContain("s.category <> 'paused'");
    // BOTH origins, not one: either column alone is a valid block home
    expect(sql).toContain('t.park_from_status is not null');
    expect(sql).toContain('t.pre_block_status is not null');
    // (a) never a mutable stamp (the r1 P1: `updated_at` is bumped by any benign edit, so a
    // pre-fix leftover would alert as a live egress failure), (b) never the ledger (a
    // restored ladder park legally carries it off the block, #211)
    expect(sql).not.toContain('updated_at');
    expect(sql).not.toContain('park_rearm');
    // one row per id, newest-agnostic, and the empty-set contract the shell parses
    expect(sql).toContain("coalesce(string_agg(t.id::text, ',' order by t.id), 'none')");
  });

  // the arm's clause names BOTH origin columns: a one-column image must refuse to emit
  // (exit 2) rather than print bytes that throw at run time (column-absent law)
  it('refuses to emit when the column gate reports a degraded schema', async () => {
    const oneCol = await $`bash ${script} --egress-sql 1`.nothrow().quiet();
    expect(oneCol.exitCode).toBe(2);
    expect(oneCol.stdout.toString().trim()).toBe('');
    const twoCol = await $`bash ${script} --egress-sql 2`.nothrow().quiet();
    expect(twoCol.exitCode).toBe(0);
    expect(twoCol.stdout.toString()).toContain("select 'egressorigin'");
  });

  it('writes no probe state in either pure dispatch mode (SPEC: no state writes)', async () => {
    // The DEFAULT state path derives from TANDEM_PROFILE_DIR — override THAT, so a broken
    // derivation cannot pass by writing the real prod trail (an overridden PROBE_STATE
    // alone would only prove the override works).
    for (const mode of [['--strand-sql', '2.78.20', '2'], ['--egress-sql'], ['--selfcheck']]) {
      const profile = `${process.env.TMPDIR ?? '/tmp'}/probe-profile-${crypto.randomUUID()}`;
      // TANDEM_PROBE_STATE='' as well: an inherited override would redirect any real
      // write away from the asserted path and green-light a broken derivation
      const proc = await $`bash ${script} ${mode}`
        .env({ TANDEM_PROFILE_DIR: profile, TANDEM_PROBE_STATE: '' })
        .nothrow()
        .quiet();
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(existsSync(profile), `${mode[0]} must not create the state directory`).toBe(false);
    }
  });
});
