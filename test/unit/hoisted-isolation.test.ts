import { beforeAll, describe, expect, it, vi } from 'vitest';

import { registeredHolderCount } from '../hoisted-isolation';

// Contract: SPEC.md "Test isolation" — a `vi.hoisted` holder is module state shared
// by every test in its file; the harness restores it before each test, so shuffle
// order can never carry one test's writes into another. These tests exercise the
// harness itself: the writes below are deliberate leaks that the restore must undo.
const h = vi.hoisted(() => ({
  rows: [] as string[],
  flag: false,
  nested: { open: false },
  seen: new Map<string, number>(),
  tags: new Set<string>(),
  seedRows: [] as string[],
}));

describe('hoisted holder isolation', () => {
  it('the harness registered this holder (a silent no-op would fake every pass below)', () => {
    expect(registeredHolderCount()).toBeGreaterThan(0);
  });

  it('a test that leaks into the holder', () => {
    h.rows.push('leaked');
    h.flag = true;
    h.nested.open = true;
    h.seen.set('k', 1);
    h.tags.add('t');
  });

  it('the next test starts from the file baseline', () => {
    expect(h.rows).toEqual([]);
    expect(h.flag).toBe(false);
    expect(h.nested.open).toBe(false);
    expect(h.seen.size).toBe(0);
    expect(h.tags.size).toBe(0);
  });

  it('a write in this test still cannot reach the one after it', () => {
    h.rows.push('second-leak');
    expect(h.rows).toHaveLength(1);
  });

  it('and the baseline still holds', () => {
    expect(h.rows).toEqual([]);
  });

  it('replacing a whole field is undone too', () => {
    h.rows = ['replaced'];
    h.nested = { open: true };
    expect(h.rows).toEqual(['replaced']);
  });

  it('including a field replaced by the previous test', () => {
    expect(h.rows).toEqual([]);
    expect(h.nested).toEqual({ open: false });
  });
});

// a reference captured at module scope: no static checker can prove what reaches it,
// but restoration does not need to — it puts the state back regardless of the path
const capturedRows = h.rows;

describe('writes through a captured reference', () => {
  it('land in the holder', () => {
    capturedRows.push('via-alias');
    expect(h.rows).toEqual(['via-alias']);
  });

  it('are undone for the next test', () => {
    expect(capturedRows).toEqual([]);
    expect(h.rows).toEqual([]);
  });
});

describe('a nested beforeAll seed', () => {
  beforeAll(() => {
    h.seedRows.push('seeded-once');
  });

  it('is visible to the first test of the describe', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });

  it('survives into the next test of the same describe (restore is not a wipe)', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });

  it('and a test that appends to it does not grow it for the next one', () => {
    h.seedRows.push('from-this-test');
    expect(h.seedRows).toEqual(['seeded-once', 'from-this-test']);
  });

  it('leaving the seed exactly as beforeAll made it', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });
});
