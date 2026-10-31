import { $ } from 'bun';
import { describe, expect, it } from 'vitest';

// Contract: SPEC.md "Ops drills" — the game-day drill refuses to run anywhere
// near prod. The drill's guards are asserted here via --selfcheck (zero side
// effects: guard evaluation only, no docker, no psql) and via direct refusal
// runs (which exit 2 before any container call).

const script = new URL('../../scripts/restore-drill.sh', import.meta.url).pathname;

const TEST_URL = 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_drill';

describe('restore-drill test-stack guards', () => {
  it('selfcheck: guards behave under all four env shapes', async () => {
    const proc = $`bash ${script} --selfcheck`.nothrow().quiet();
    const { exitCode, stdout } = await proc;
    const out = stdout.toString();
    expect(exitCode, out).toBe(0);
    expect(out).toContain('ok   no DRILL_TEST_STACK confirmation -> REFUSE');
    expect(out).toContain('ok   prod marker in DATABASE_URL -> REFUSE');
    expect(out).toContain('ok   missing DATABASE_URL -> REFUSE');
    expect(out).toContain('ok   test stack -> ALLOW');
  });

  it('refuses to run without explicit DRILL_TEST_STACK=1 confirmation', async () => {
    const proc = $`bash ${script}`.env({ DRILL_TEST_STACK: '', DATABASE_URL: TEST_URL }).nothrow().quiet();
    const { exitCode, stderr } = await proc;
    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain('DRILL_TEST_STACK');
  });

  it('refuses to run when DATABASE_URL carries a prod marker', async () => {
    const proc = $`bash ${script}`
      .env({
        DRILL_TEST_STACK: '1',
        DATABASE_URL: 'postgresql://tandem@work-ultranomic-net.internal:5432/tandem',
      })
      .nothrow()
      .quiet();
    const { exitCode, stderr } = await proc;
    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain('prod marker');
  });

  it('refuses to run with no DATABASE_URL at all', async () => {
    const proc = $`bash ${script}`.env({ DRILL_TEST_STACK: '1', DATABASE_URL: '' }).nothrow().quiet();
    const { exitCode, stderr } = await proc;
    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain('DATABASE_URL');
  });
});
