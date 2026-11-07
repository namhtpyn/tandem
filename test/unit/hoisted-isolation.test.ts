import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registeredHolderCount } from '../hoisted-isolation';

// Contract: SPEC.md "Test isolation" — a `vi.hoisted` holder is module state shared
// by every test in its file; the harness restores it when a test ends, so shuffle
// order can never carry one test's writes into another. Every test below asserts a
// CLEAN SLATE FIRST (every field, not just the one it is about to foul): whichever
// test runs second catches a broken restore of any field, so the proof never depends
// on declaration order and no restore branch can be dropped without a red test.
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
    bytes: new Uint8Array([1, 2, 3]),
    query: new URLSearchParams('a=1'),
    symbolKey,
    [symbolKey]: 0,
  };
});

// a function-valued holder: own props tests hang on the mock must be restored
const fnHolder = vi.hoisted(() => {
  const fn = vi.fn(() => 'ok') as ReturnType<typeof vi.fn> & { tag?: string };
  fn.tag = 'base';
  return fn;
});

// an ArrayBuffer plus a subarray view over it: the view's restore must write only
// its own byte range, and the buffer's restore covers the rest
const bytes = vi.hoisted(() => {
  const raw = new ArrayBuffer(8);
  const view = new Uint8Array(raw, 2, 4);
  view.set([7, 8, 9, 10]);
  return { raw, view };
});

// a NON-empty seeded array: element restore is load-bearing for every test below
// (an always-empty array cannot catch a dropped element write)
const fixed = vi.hoisted(() => ({
  list: ['a', 'b'] as string[],
}));

// a seeded array with a HOLE: restoring must put the hole back, not just the values
const holes = vi.hoisted(() => {
  const list = ['x', 'y', 'z'];
  delete (list as unknown as Record<string, unknown>)[1];
  return { list };
});

// frozen file state: restore must leave frozen containers untouched (no crash, no wipe)
const frozen = vi.hoisted(() => {
  const list = Object.freeze(['keep-1', 'keep-2']);
  const config = Object.freeze({ limits: { max: 10 } });
  return { list, config };
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

// a reference captured at module scope: no static checker can prove what reaches it
const capturedRows = h.rows;

const BASE_TIME = '2026-01-01T00:00:00.000Z';

/** every field the harness promises to restore, checked in one place */
function assertClean(): void {
  expect(h.rows).toEqual([]);
  expect(h.flag).toBe(false);
  expect(h.nested).toEqual({ open: false, deep: { count: 0 } });
  expect(h.seen.size).toBe(0);
  expect(h.tags.size).toBe(0);
  expect(h.when.toISOString()).toBe(BASE_TIME);
  expect([...h.bytes]).toEqual([1, 2, 3]);
  expect(h.query.toString()).toBe('a=1');
  expect(h[h.symbolKey]).toBe(0);
  expect(cyclic.graph.name).toBe('parent');
  expect(cyclic.graph.child?.name).toBe('child');
  expect(cyclic.graph.child?.child).toBe(cyclic.graph);
  expect(capturedRows).toEqual([]);
  expect(fnHolder.tag).toBe('base');
  expect([...bytes.view]).toEqual([7, 8, 9, 10]);
  expect([...new Uint8Array(bytes.raw)]).toEqual([0, 0, 7, 8, 9, 10, 0, 0]);
  expect((h.rows as unknown as Record<string, unknown>).note).toBeUndefined();
  expect('extra' in h.nested).toBe(false);
  expect((h.seen as unknown as Record<string, unknown>).note).toBeUndefined();
  expect((h.tags as unknown as Record<string, unknown>).note).toBeUndefined();
  expect((h.when as unknown as Record<string, unknown>).note).toBeUndefined();
  expect((h.query as unknown as Record<string, unknown>).note).toBeUndefined();
  expect((h.bytes as unknown as Record<string, unknown>).note).toBeUndefined();
  expect(fixed.list).toEqual(['a', 'b']);
  expect(frozen.list).toEqual(['keep-1', 'keep-2']);
  expect(frozen.config.limits.max).toBe(10);
  expect(1 in holes.list).toBe(false);
  expect(holes.list).toEqual(['x', undefined, 'z']);
  expect((bytes.raw as unknown as Record<string, unknown>).note).toBeUndefined();
}

describe('hoisted holder isolation', () => {
  it('the harness registered this holder (a silent no-op would fake every pass below)', () => {
    expect(registeredHolderCount()).toBeGreaterThan(0);
  });

  it('arrays: a test starts empty and its push does not survive', () => {
    assertClean();
    h.rows.push(marker('arrays'));
    expect(h.rows).toEqual([marker('arrays')]);
  });

  it('scalars and nested objects: no sticky flag, no sticky count', () => {
    assertClean();
    h.flag = true;
    h.nested.open = true;
    h.nested.deep.count += 1;
  });

  it('collections: a Map and a Set start empty', () => {
    assertClean();
    h.seen.set('k', 1);
    h.tags.add('t');
  });

  it('a Date is restored in place, keeping its identity', () => {
    assertClean();
    const original = h.when;
    h.when.setTime(Date.parse('2026-06-01T00:00:00Z'));
    expect(original).toBe(h.when);
  });

  it('typed arrays and URLSearchParams are restored in place', () => {
    assertClean();
    h.bytes.fill(9);
    h.query.set('a', '2');
    h.query.append('b', '3');
  });

  it('symbol-keyed fields are restored too', () => {
    assertClean();
    h[h.symbolKey] = 5;
  });

  it('a cyclic fixture is restored without blowing the stack', () => {
    assertClean();
    (cyclic.graph.child as { name: string }).name = 'renamed';
    (cyclic.graph.child as { child?: unknown }).child = null;
  });

  it('whole-field replacement is undone as well', () => {
    assertClean();
    h.rows = [marker('replaced')];
    h.nested = { open: true, deep: { count: 9 } };
    expect(h.rows).toEqual([marker('replaced')]);
  });

  it('a function holder keeps its own props across tests', () => {
    assertClean();
    fnHolder.tag = 'dirty';
    fnHolder('call');
    expect(fnHolder.tag).toBe('dirty');
  });

  it('an ArrayBuffer and a subarray over it restore only their own bytes', () => {
    assertClean();
    new Uint8Array(bytes.raw)[0] = 42;
    bytes.view[3] = 99;
  });

  it('added keys are removed and deleted keys come back', () => {
    assertClean();
    (h.rows as unknown as Record<string, unknown>).note = 'sticky';
    (h.nested as Record<string, unknown>).extra = 1;
    delete (h.nested as unknown as Record<string, unknown>).deep;
    expect('extra' in h.nested).toBe(true);
    expect('deep' in h.nested).toBe(false);
  });

  it('element writes into a seeded array are undone (array restore is load-bearing)', () => {
    assertClean();
    fixed.list[0] = 'dirty';
    expect(fixed.list).toEqual(['dirty', 'b']);
  });

  it('container expandos on every collection kind are removed', () => {
    assertClean();
    (h.seen as unknown as Record<string, unknown>).note = 'x';
    (h.tags as unknown as Record<string, unknown>).note = 'x';
    (h.when as unknown as Record<string, unknown>).note = 'x';
    (h.query as unknown as Record<string, unknown>).note = 'x';
    (h.bytes as unknown as Record<string, unknown>).note = 'x';
    (bytes.raw as unknown as Record<string, unknown>).note = 'x';
  });

  it('a hole in a seeded array is a hole after the restore', () => {
    assertClean();
    holes.list[1] = 'filled';
    expect(holes.list).toEqual(['x', 'filled', 'z']);
  });

  it('a frozen array stays untouched and never crashes the restore', () => {
    assertClean();
    // push would throw on a frozen array (strict mode) — the harness must not try
    expect(() => (frozen.list as unknown as string[]).push('x')).toThrow();
    expect(frozen.list).toEqual(['keep-1', 'keep-2']);
  });

  it('a frozen object is left alone, but its mutable child restores in place', () => {
    assertClean();
    frozen.config.limits.max = 99;
    expect(frozen.config.limits.max).toBe(99);
  });

  it('resetting in place keeps a captured reference pointing at the array', () => {
    assertClean();
    // the convention: reset containers in place (`rows.length = 0`), never by
    // reassigning (`rows = []`) — a mock that captured the array keeps writing
    // into the object the test reads
    h.rows.push('before');
    h.rows.length = 0;
    capturedRows.push(marker('in-place'));
    expect(h.rows).toEqual([marker('in-place')]);
  });
});

describe('a nested beforeAll seed', () => {
  beforeAll(() => {
    h.seedRows.push('seeded-once');
  });

  it('is visible to its own tests', () => {
    assertClean();
    expect(h.seedRows).toEqual(['seeded-once']);
  });

  it('is file state, not a leak: the seed persists and test writes do not', () => {
    assertClean();
    expect(h.seedRows).toEqual(['seeded-once']);
    h.seedRows.push(marker('seed'));
    expect(h.seedRows).toEqual(['seeded-once', marker('seed')]);
  });

  it('leaving the seed exactly as beforeAll made it', () => {
    expect(h.seedRows).toEqual(['seeded-once']);
  });
});

// LIMIT: restore is per test, so tests that run concurrently over the SAME holder
// interleave their writes — the harness can only promise it never throws and never
// wipes a *finished* test's own snapshot. Keep `describe.concurrent` suites off
// shared holders, or hold per-test state in locals.
describe.concurrent('concurrent tests over a shared holder', () => {
  it('one', async () => {
    const local = marker('one');
    h.rows.push(local);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(local).toBe('leak:one');
  });

  it('two', async () => {
    const local = marker('two');
    h.rows.push(local);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(local).toBe('leak:two');
  });

  it('the restore never throws while siblings are in flight', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(Array.isArray(h.rows)).toBe(true);
  });
});

afterAll(() => {
  // afterAll runs after the last restore: a file's trailing state must be clean
  assertClean();
  expect(h.seedRows).toEqual(['seeded-once']);
  expect(fixed.list).toEqual(['a', 'b']);
  expect(frozen.config.limits.max).toBe(10);
  expect(1 in holes.list).toBe(false);
  expect(holes.list).toEqual(['x', undefined, 'z']);
  expect((bytes.raw as unknown as Record<string, unknown>).note).toBeUndefined();
});
