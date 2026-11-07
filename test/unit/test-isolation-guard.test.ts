import { describe, expect, it } from 'vitest';

import { auditSource, auditTree } from '../../scripts/check-test-isolation';

// Contract: SPEC.md "Test isolation" — a `vi.hoisted` holder is module state shared
// by every test in its file; under `sequence.shuffle` any field the tests mutate
// must be reset in a beforeEach or the next test inherits it (the flaky-suite class
// this guard exists to stop). The checker itself is pinned here: a guard that cannot
// fail is worse than no guard.
const wrap = (body: string): string => `import { beforeEach, it, vi } from 'vitest';\n${body}`;
// the opt-out marker is assembled so this file does not look exempt itself
const MARKER = ['// isolation', 'ok: seeded once in beforeAll, read-only per test'].join('-');

describe('check-test-isolation', () => {
  it('flags a field the tests mutate but never reset', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ rows: [] as string[], flag: false }));
it('a', () => {
  h.rows.push('a');
  h.flag = true;
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    const found = auditSource('leak.test.ts', src);
    expect(found.map((v) => v.field).sort()).toEqual(['flag', 'rows']);
  });

  it('accepts a beforeEach that puts the field back', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ rows: [] as string[], flag: false }));
beforeEach(() => {
  h.rows = [];
  h.flag = false;
});
it('a', () => {
  h.rows.push('a');
  h.flag = true;
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('clean.test.ts', src)).toEqual([]);
  });

  it('accepts a reset handed to beforeEach as a whole helper', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ rows: [] as string[] }));
const reset = () => {
  h.rows = [];
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

  it('accepts a clear() inside the hook for a Map holder', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ rows: new Map<string, string>() }));
beforeEach(() => {
  h.rows.clear();
});
it('a', () => {
  h.rows.set('k', 'v');
});
it('b', () => {
  expect(h.rows.size).toBe(0);
});
`);
    expect(auditSource('map.test.ts', src)).toEqual([]);
  });

  it('exempts a single-test file (nothing can leak)', () => {
    const src = wrap(`
const h = vi.hoisted(() => ({ rows: [] as string[] }));
it('only', () => {
  h.rows.push('a');
});
`);
    expect(auditSource('single.test.ts', src)).toEqual([]);
  });

  it('honours isolation-ok only when a reason is written', () => {
    const withReason = wrap(`
${MARKER}
const h = vi.hoisted(() => ({ rows: [] as string[] }));
it('a', () => {
  h.rows.push('a');
});
it('b', () => {
  expect(h.rows).toHaveLength(0);
});
`);
    expect(auditSource('exempt.test.ts', withReason)).toEqual([]);
    const withoutReason = withReason.replace(MARKER, MARKER.replace(/:.*/, ':'));
    expect(auditSource('exempt.test.ts', withoutReason)).toHaveLength(1);
  });

  it('ignores files without a hoisted holder', () => {
    expect(auditSource('plain.test.ts', wrap(`it('a', () => {});\nit('b', () => {});`))).toEqual([]);
  });

  it('the repo tree itself is clean', () => {
    const { violations, scanned } = auditTree('test/unit');
    expect(violations).toEqual([]);
    expect(scanned).toBeGreaterThan(30);
  });
});
