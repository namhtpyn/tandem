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

  it('writes no probe state in either pure dispatch mode (SPEC: no state writes)', async () => {
    // The DEFAULT state path derives from TANDEM_PROFILE_DIR — override THAT, so a broken
    // derivation cannot pass by writing the real prod trail (an overridden PROBE_STATE
    // alone would only prove the override works).
    for (const mode of [['--strand-sql', '2.78.20', '2'], ['--selfcheck']]) {
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
