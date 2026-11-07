import { beforeAll, describe, expect, it, vi } from 'vitest';

import { registeredHolderCount } from '../hoisted-isolation';

// Contract: SPEC.md "Test isolation" — a `vi.hoisted` holder is module state shared
// by every test in its file; the harness restores it when a test ends, so shuffle
// order can never carry one test's writes into another. Every test below fouls the
// holder on purpose and asserts a clean slate FIRST: whichever test runs second
// catches a broken restore, so the proof does not depend on declaration order.
const marker = (name: string) => `leak:${name}`;

const h = vi.hoisted(() => {
  // the symbol must be created inside the factory: vi.hoisted runs before the
  // module's const declarations (TDZ), so it cannot close over one
  const symbolKey = Symbol('symbolKey');
  return {
    rows: [] as string[],
    flag: false,
    nested: { open: false, deep: { count: 0 } },
    seen: new Map<string, number>(),
    tags: new Set<string>(),
    seedRows: [] as string[],
    when: new Date('2026-01-01T00:00:00Z'),
    symbolKey,
    [symbolKey]: 0,
  };
});

// a cyclic fixture: restore must walk it without recursing forever
const cyclic = vi.hoisted(() => {
  type Node = { name: string; child?: Node };
  const parent: Node = { name: 'parent' };
  const child: Node = { name: 'child' };
  parent.child = child;
  child.child = parent; // cycle
  return { graph: parent };
});

describe('hoisted holder isolation', () => {
  it('the harness registered this holder (a silent no-op would fake every pass below)', () => {
    expect(registeredHolderCount()).toBeGreaterThan(0);
  });

  it('arrays: every test starts empty, whatever ran before it', () => {
    expect(h.rows).toEqual([]);
    h.rows.push(marker('arrays'));
  });

  it('scalars and nested objects: no sticky flag, no sticky count', () => {
    expect(h.flag).toBe(false);
    expect(h.nested).toEqual({ open: false, deep: { count: 0 } });
    h.flag = true;
    h.nested.open = true;
    h.nested.deep.count += 1;
  });

  it('collections: a Map and a Set start empty', () => {
    expect(h.seen.size).toBe(0);
    expect(h.tags.size).toBe(0);
    h.seen.set('k', 1);
    h.tags.add('t');
  });

  it('a Date is restored in place, keeping its identity', () => {
    const original = h.when;
    expect(h.when.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    h.when.setTime(Date.parse('2026-06-01T00:00:00Z'));
    expect(original).toBe(h.when);
  });

  it('symbol-keyed fields are restored too', () => {
    expect(h[h.symbolKey]).toBe(0);
    h[h.symbolKey] = 5;
  });

  it('a cyclic fixture is restored without blowing the stack', () => {
    expect(cyclic.graph.child?.name).toBe('child');
    expect(cyclic.graph.child?.child).toBe(cyclic.graph);
    (cyclic.graph.child as { name: string }).name = 'renamed';
    (cyclic.graph.child as { child?: unknown }).child = null;
  });

  it('whole-field replacement is undone as well', () => {
    expect(h.rows).toEqual([]);
    h.rows = [marker('replaced')];
    h.nested = { open: true, deep: { count: 9 } };
    expect(h.rows).toEqual([marker('replaced')]);
  });

  it('and the replacement did not stick', () => {
    expect(h.rows).toEqual([]);
    expect(h.nested).toEqual({ open: false, deep: { count: 0 } });
  });
});

// a reference captured at module scope: no static checker can prove what reaches it,
// restoration does not need to — it puts the state back regardless of the path
const capturedRows = h.rows;

describe('writes through a captured reference', () => {
  it('land in the holder and are undone', () => {
    expect(capturedRows).toEqual([]);
    capturedRows.push(marker('alias'));
    expect(h.rows).toEqual([marker('alias')]);
  });

  it('never survive into the next test', () => {
    expect(capturedRows).toEqual([]);
  });
});

describe('a nested beforeAll seed', () => {
  beforeAll(() => {
    h.seedRows.push('seeded-once');
  });

  it('is visible to its own tests', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });

  it('is file state, not a leak: the seed persists and test writes do not', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
    h.seedRows.push(marker('seed'));
    expect(h.seedRows).toEqual(['seeded-once', marker('seed')]);
  });

  it('leaving the seed exactly as beforeAll made it', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });
});
