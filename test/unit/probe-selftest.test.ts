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
    const on = await $`bash ${script} --strand-sql 2.78.20 2`.nothrow().quiet();
    expect(on.exitCode, on.stderr.toString()).toBe(0);
    const sql = on.stdout.toString();
    expect(sql).toContain("select 'wedge'");
    expect(sql).toContain("s.category = 'in_review'");
    expect(sql).toContain('park_from_status is null');
    expect(sql).toContain("r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')");
    expect(sql).toContain("select 'lostsettle'");

    const below = await $`bash ${script} --strand-sql 2.78.19 2`.nothrow().quiet();
    expect(below.exitCode, below.stderr.toString()).toBe(0);
    // a pre-block image cannot heal the shape: the branch must not exist in its SQL
    expect(below.stdout.toString()).not.toContain('park_from_status');
    expect(below.stdout.toString()).toContain("select 'wedge'");

    const noColumns = await $`bash ${script} --strand-sql 2.78.20 1`.nothrow().quiet();
    expect(noColumns.stdout.toString()).not.toContain('park_from_status');
  });
});
