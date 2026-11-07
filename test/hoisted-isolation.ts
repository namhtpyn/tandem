// TEST-ISOLATION HARNESS (#346): `vi.hoisted(…)` returns module state shared by
// every test in the file. `sequence.shuffle` reorders tests, so a test that writes
// such state without putting it back seeds the next test — the flaky-suite class
// (retention-leg's fault flag, an accumulating read log, a sticky switch).
//
// Instead of statically guessing which writes leak (regex and AST both have blind
// spots: aliasing, closures, imported helpers, dynamic keys), this harness snapshots
// every hoisted holder at the start of each test and puts it back when that test
// ends. Every test therefore starts from the same state — module and beforeAll
// seeds included — and no write form can escape it.
//
// Restoration is identity-preserving: containers and fixture objects are put back
// IN PLACE (never swapped for copies) because mocks capture those references at
// module load and tests assert through them.
import { afterEach, beforeEach, vi } from 'vitest';

type Holder = Record<string, unknown>;

type Snap =
  | { kind: 'array'; ref: unknown[]; items: Snap[] }
  | { kind: 'map'; ref: Map<unknown, unknown>; entries: Array<[Snap, Snap]> }
  | { kind: 'set'; ref: Set<unknown>; items: Snap[] }
  | { kind: 'object'; ref: Record<string, unknown>; props: Record<string, Snap> }
  | { kind: 'value'; value: unknown };

const holders: Holder[] = [];
let pending: Map<Holder, Record<string, Snap>> | null = null;
let exemption: string | null = null;

function snapshotHolders(): Map<Holder, Record<string, Snap>> {
  return new Map(
    holders.map((holder) => [
      holder,
      Object.fromEntries(Object.entries(holder).map(([key, value]) => [key, snapshot(value)])),
    ]),
  );
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshot(value: unknown, seen = new Map<object, Snap>()): Snap {
  if (typeof value === 'object' && value !== null) {
    const known = seen.get(value);
    if (known) return known;
  }
  if (Array.isArray(value)) {
    const snap: Snap = { kind: 'array', ref: value, items: [] };
    seen.set(value, snap);
    snap.items = value.map((item) => snapshot(item, seen));
    return snap;
  }
  if (value instanceof Map) {
    const snap: Snap = { kind: 'map', ref: value, entries: [] };
    seen.set(value, snap);
    snap.entries = [...value.entries()].map(([key, item]) => [snapshot(key, seen), snapshot(item, seen)]);
    return snap;
  }
  if (value instanceof Set) {
    const snap: Snap = { kind: 'set', ref: value, items: [] };
    seen.set(value, snap);
    snap.items = [...value].map((item) => snapshot(item, seen));
    return snap;
  }
  if (isPlain(value)) {
    const snap: Snap = { kind: 'object', ref: value, props: {} };
    seen.set(value, snap);
    for (const key of Object.keys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      // accessors (fixture getters) and readonly props are state, not writable fields
      if (!desc || !('value' in desc) || desc.writable === false) continue;
      snap.props[key] = snapshot(desc.value, seen);
    }
    return snap;
  }
  // primitives, functions, class instances, streams, spies — restored by value/reference
  return { kind: 'value', value };
}

/** write the snapshot's contents back into its own containers; returns the original value */
function restoreSnap(snap: Snap): unknown {
  if (snap.kind === 'value') return snap.value;
  if (snap.kind === 'array') {
    const items = snap.items.map((item) => restoreSnap(item));
    snap.ref.length = 0;
    snap.ref.push(...items);
    return snap.ref;
  }
  if (snap.kind === 'map') {
    const entries = snap.entries.map(([key, item]) => [restoreSnap(key), restoreSnap(item)] as const);
    snap.ref.clear();
    for (const [key, item] of entries) snap.ref.set(key, item);
    return snap.ref;
  }
  if (snap.kind === 'set') {
    const items = snap.items.map((item) => restoreSnap(item));
    snap.ref.clear();
    for (const item of items) snap.ref.add(item);
    return snap.ref;
  }
  for (const key of Object.keys(snap.ref)) {
    if (key in snap.props) continue;
    const desc = Object.getOwnPropertyDescriptor(snap.ref, key);
    if (desc && 'value' in desc && desc.writable === false) continue;
    delete snap.ref[key];
  }
  for (const [key, item] of Object.entries(snap.props)) {
    const desc = Object.getOwnPropertyDescriptor(snap.ref, key);
    if (desc && (!('value' in desc) || desc.writable === false)) continue;
    snap.ref[key] = restoreSnap(item);
  }
  return snap.ref;
}

/** wrap `vi.hoisted` so every holder object it returns is registered for restoration */
export function installHoistedIsolation(): void {
  const api = vi as unknown as { hoisted: <T>(factory: () => T) => T };
  const original = api.hoisted.bind(vi);
  api.hoisted = (<T>(factory: () => T): T => {
    const value = original(factory);
    if (isPlain(value)) holders.push(value);
    return value;
  }) as typeof api.hoisted;

  beforeEach(() => {
    if (exemption) return;
    pending = snapshotHolders();
  });

  afterEach(() => {
    if (exemption || pending === null) return;
    for (const [holder, props] of pending) {
      for (const key of Object.keys(holder)) if (!(key in props)) delete holder[key];
      for (const [key, snap] of Object.entries(props)) holder[key] = restoreSnap(snap);
    }
    pending = null;
  });
}

/**
 * Opt a whole file out of holder restoration. Only for fixtures whose shared state
 * is NOT a `vi.hoisted` holder (e.g. a module that caches a live domain by design);
 * the reason is required and shows up in review.
 */
export function exemptHoistedIsolation(reason: string): void {
  if (!reason.trim()) throw new Error('exemptHoistedIsolation needs a reason');
  exemption = reason;
}

/** test-only introspection: how many holders this file registered */
export function registeredHolderCount(): number {
  return holders.length;
}
