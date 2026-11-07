import { describe, expect, it } from 'vitest';

import { auditSource, auditTree } from '../../scripts/check-test-isolation';

// Contract: SPEC.md "Test isolation" — a `vi.hoisted` holder is module state shared
// by every test in its file; under `sequence.shuffle` any field a test writes must be
// reset by a beforeEach/afterEach on that test's describe chain, or the next test
// inherits it. These cases pin the checker in BOTH directions: a guard that cannot
// fail is worse than no guard, and a guard that red-builds honest code gets switched
// off. Parsing is AST-based, so comments/strings must never satisfy a reset.
const wrap = (body: string): string => `import { beforeEach, it, vi } from 'vitest';\n${body}`;
// assembled so this file does not look exempt itself
const MARKER = ['// isolation', 'ok(h): seeded once in beforeAll, read-only per test'].join('-');
const H = `const h = vi.hoisted(() => ({ rows: [] as string[], flag: false, state: { open: false } }));`;

describe('check-test-isolation', () => {
  it('flags a field a test mutates but never resets', () => {
    const src = wrap(`
${H}
it('a', () => {
  h.rows.push('a');
  h.flag = true;
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(
      auditSource('leak.test.ts', src)
        .map((v) => v.field)
        .sort(),
    ).toEqual(['flag', 'rows']);
  });

  it('sees compound assignments and update expressions', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ calls: 0, hits: 0 }));
it('a', () => {
  h.calls += 1;
});
it('b', () => {
  h.hits++;
});
`);
    expect(
      auditSource('compound.test.ts', src)
        .map((v) => v.field)
        .sort(),
    ).toEqual(['calls', 'hits']);
  });

  it('sees writes through a nested path and through a local alias', () => {
    const nested = wrap(`
${H}
it('a', () => {
  h.state.open = true;
});
it('b', () => {
  expect(h.state.open).toBe(false);
});
`);
    expect(auditSource('nested.test.ts', nested).map((v) => v.field)).toEqual(['state']);

    const aliased = wrap(`
${H}
it('a', () => {
  const rows = h.rows;
  rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('alias.test.ts', aliased).map((v) => v.field)).toEqual(['rows']);
  });

  it('accepts a beforeEach reset, a length reset and a clear()', () => {
    const assign = wrap(`
${H}
beforeEach(() => {
  h.rows = [];
  h.flag = false;
  h.state = { open: false };
});
it('a', () => {
  h.rows.push('a');
  h.flag = true;
  h.state.open = true;
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('assign.test.ts', assign)).toEqual([]);

    const cleared = wrap(`
const h = vi.hoisted(() => ({ seen: new Map<string, string>(), log: [] as string[] }));
beforeEach(() => {
  h.seen.clear();
  h.log.length = 0;
});
it('a', () => {
  h.seen.set('k', 'v');
  h.log.push('x');
});
it('b', () => {
  expect(h.seen.size).toBe(0);
});
`);
    expect(auditSource('clear.test.ts', cleared)).toEqual([]);

    const after = wrap(`
${H}
afterEach(() => {
  h.rows = [];
  h.flag = false;
  h.state = { open: false };
});
it('a', () => {
  h.rows.push('a');
  h.flag = true;
  h.state.open = true;
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('after.test.ts', after)).toEqual([]);
  });

  it('accepts a reset handed to beforeEach as a whole helper', () => {
    const src = wrap(`
${H}
const reset = (): void => {
  h.rows = [];
  h.flag = false;
  h.state = { open: false };
};
beforeEach(reset);
it('a', () => {
  h.rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('helper.test.ts', src)).toEqual([]);
  });

  it('ignores writes that run once per file (module scope, beforeAll)', () => {
    const src = wrap(`
${H}
h.rows.push('module');
beforeAll(() => {
  h.rows.push('once');
});
it('a', () => {
  expect(h.rows.length).toBeGreaterThan(0);
});
it('b', () => {
  expect(h.rows.length).toBeGreaterThan(0);
});
`);
    expect(auditSource('once.test.ts', src)).toEqual([]);
  });

  it('does not let a comment or string fake a reset', () => {
    const src = wrap(`
${H}
beforeEach(() => {
  // h.rows = [];  (a promise, not code)
  const note = 'h.flag = false';
  void note;
});
it('a', () => {
  h.rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('comment.test.ts', src).map((v) => v.field)).toEqual(['rows']);
  });

  it('a reset in a sibling describe does not cover the leaking one', () => {
    const src = wrap(`
${H}
describe('one', () => {
  it('a', () => {
    h.rows.push('a');
  });
  it('b', () => {
    expect(h.rows).toHaveLength(0);
  });
});
describe('two', () => {
  beforeEach(() => {
    h.rows = [];
  });
  it('c', () => {
    h.rows.push('c');
  });
  it('d', () => {
    expect(h.rows).toHaveLength(0);
  });
});
`);
    expect(auditSource('describe.test.ts', src).map((v) => v.field)).toEqual(['rows']);
  });

  it('counts it.each / it.concurrent tests, so a multi-test file is never exempt', () => {
    const each = wrap(`
${H}
it.each([1, 2])('case %i', () => {
  h.rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('each.test.ts', each).map((v) => v.field)).toEqual(['rows']);
  });

  it('exempts a single-test file (nothing can leak)', () => {
    const src = wrap(`
${H}
it('only', () => {
  h.rows.push('a');
});
`);
    expect(auditSource('single.test.ts', src)).toEqual([]);
  });

  it('skips a hoisted mock function (no module state of its own)', () => {
    const src = wrap(`
const handle = vi.hoisted(() => vi.fn(async () => 'ok'));
it('a', async () => {
  await handle();
});
it('b', async () => {
  await handle();
});
`);
    expect(auditSource('mockfn.test.ts', src)).toEqual([]);
  });

  it('honours isolation-ok only per holder and only with a reason', () => {
    const withReason = wrap(`
${MARKER}
${H}
it('a', () => {
  h.rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('exempt.test.ts', withReason)).toEqual([]);
    const withoutReason = withReason.replace(MARKER, MARKER.replace(/:.*/, ':'));
    expect(auditSource('exempt.test.ts', withoutReason).map((v) => v.field)).toEqual(['rows']);
    // the marker must name the holder it exempts
    expect(auditSource('other.test.ts', withReason.replace('ok(h)', 'ok(other)')).map((v) => v.field)).toEqual([
      'rows',
    ]);
  });

  it('flags a holder it cannot analyze instead of silently skipping it', () => {
    const src = wrap(`
const { rows } = vi.hoisted(() => ({ rows: [] as string[] }));
it('a', () => {
  rows.push('a');
});
it('b', () => {
  expect(rows).toHaveLength(0);
});
`);
    expect(auditSource('destructured.test.ts', src).map((v) => v.field)).toEqual(['(holder)']);
  });

  it('the repo tree itself is clean', () => {
    const { violations, scanned } = auditTree('test/unit');
    expect(violations).toEqual([]);
    expect(scanned).toBeGreaterThan(30);
  });
});
