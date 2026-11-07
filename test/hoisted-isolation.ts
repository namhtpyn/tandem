// TEST-ISOLATION HARNESS (#346): `vi.hoisted(…)` returns module state shared by
// every test in the file. `sequence.shuffle` reorders tests, so a test that writes
// such state without putting it back seeds the next test — the flaky-suite class
// (retention-leg's fault flag, an accumulating read log, a sticky switch).
//
// Static analysis (regex or AST) cannot decide this: writes reach holder state
// through aliases, closures, imported helpers and dynamic keys, so a checker either
// misses leaks or red-builds honest code. This harness enforces the invariant by
// construction instead: every holder is snapshotted when a test starts and put back
// when that test ends, so a test's writes never survive into the next one.
//
// Semantics (exact):
//   - writes made by a test body, its beforeEach/afterEach hooks, or anything they
//     call are undone when the test ends;
//   - writes made by `beforeAll` (module scope included) are file state and persist
//     for the rest of the file — a suite seed is not a leak;
//   - restoration is identity-preserving: containers and fixture objects are put
//     back IN PLACE, never swapped for copies, because mocks capture those
//     references at module load and tests assert through them;
//   - accessors (fixture getters) and readonly fields are never deleted or written;
//   - a throwing file-level afterEach can skip the restore (vitest aborts the
//     remaining afterEach hooks) — keep afterEach hooks non-throwing.
import { afterEach, beforeEach, vi } from 'vitest';

type Holder = Record<PropertyKey, unknown>;

type Extra = { keys: PropertyKey[]; data: Array<[PropertyKey, Snap]> };

type Snap =
  | { kind: 'array'; ref: unknown[]; items: Array<{ present: boolean; snap: Snap }>; extra: Extra }
  | { kind: 'map'; ref: Map<unknown, unknown>; entries: Array<[Snap, Snap]>; extra: Extra }
  | { kind: 'set'; ref: Set<unknown>; items: Snap[]; extra: Extra }
  | { kind: 'object'; ref: Holder; allKeys: PropertyKey[]; data: Array<[PropertyKey, Snap]> }
  | { kind: 'date'; ref: Date; time: number; extra: Extra }
  | { kind: 'bytes'; ref: ArrayBufferView; bytes: Uint8Array; extra: Extra }
  | { kind: 'buffer'; ref: ArrayBuffer; bytes: Uint8Array; extra: Extra }
  | { kind: 'params'; ref: URLSearchParams; query: string; extra: Extra }
  | { kind: 'value'; value: unknown };

const holders: object[] = [];
// keyed by the running test: `describe.concurrent` runs tests in parallel, so a
// single pending slot would let one test's restore wipe another's state
const pending = new Map<string, Snap[]>();

/** own writable data props that are not container slots (expandos a test may hang) */
function extrasOf(ref: object, skip: (key: PropertyKey) => boolean, seen: Map<object, Snap>): Extra {
  const keys = Reflect.ownKeys(ref);
  const data: Array<[PropertyKey, Snap]> = [];
  for (const key of keys) {
    if (skip(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(ref, key);
    if (!desc || !('value' in desc) || desc.writable !== true) continue;
    data.push([key, snapshot(desc.value, seen)]);
  }
  return { keys, data };
}

function restoreExtras(ref: object, extra: Extra, seen: Set<Snap>): void {
  for (const key of Reflect.ownKeys(ref)) {
    if (extra.keys.includes(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(ref, key);
    if (!desc || desc.configurable === false) continue;
    delete (ref as Record<PropertyKey, unknown>)[key];
  }
  for (const [key, item] of extra.data) {
    const desc = Object.getOwnPropertyDescriptor(ref, key);
    if (desc && (!('value' in desc) || desc.writable !== true)) continue;
    (ref as Record<PropertyKey, unknown>)[key] = restoreSnap(item, seen);
  }
}

const NOT_INDEX = (key: PropertyKey): boolean => typeof key === 'string' && /^\d+$/.test(key);

function isPlain(value: unknown): value is Holder {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshot(value: unknown, seen = new Map<object, Snap>()): Snap {
  if (typeof value === 'function') {
    // a hoisted function holder (`vi.hoisted(() => vi.fn())`): own writable props
    // (custom fields tests hang on the mock) are restored; vitest's mock internals
    // are non-writable, so they are left to `restoreMocks`
    const fnSnap: Snap = { kind: 'object', ref: value as unknown as Holder, allKeys: Reflect.ownKeys(value), data: [] };
    seen.set(value, fnSnap);
    for (const key of fnSnap.allKeys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc) || desc.writable !== true) continue;
      fnSnap.data.push([key, snapshot(desc.value, seen)]);
    }
    return fnSnap;
  }
  if (typeof value !== 'object' || value === null) return { kind: 'value', value };
  const known = seen.get(value);
  if (known) return known;
  if (Array.isArray(value)) {
    const snap: Snap = { kind: 'array', ref: value, items: [], extra: { keys: [], data: [] } };
    seen.set(value, snap);
    snap.extra = extrasOf(value, (key) => key === 'length' || NOT_INDEX(key), seen);
    snap.items = Array.from({ length: value.length }, (_, index) =>
      index in value
        ? { present: true, snap: snapshot(value[index], seen) }
        : { present: false, snap: { kind: 'value', value: undefined } },
    );
    return snap;
  }
  if (value instanceof Map) {
    const snap: Snap = { kind: 'map', ref: value, entries: [], extra: { keys: [], data: [] } };
    seen.set(value, snap);
    snap.extra = extrasOf(value, () => false, seen);
    snap.entries = [...value.entries()].map(([key, item]) => [snapshot(key, seen), snapshot(item, seen)]);
    return snap;
  }
  if (value instanceof Set) {
    const snap: Snap = { kind: 'set', ref: value, items: [], extra: { keys: [], data: [] } };
    seen.set(value, snap);
    snap.extra = extrasOf(value, () => false, seen);
    snap.items = [...value].map((item) => snapshot(item, seen));
    return snap;
  }
  if (value instanceof Date)
    return { kind: 'date', ref: value, time: value.getTime(), extra: extrasOf(value, () => false, seen) };
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { kind: 'bytes', ref: value, bytes: view.slice(), extra: extrasOf(value, () => false, seen) };
  }
  if (value instanceof ArrayBuffer)
    return {
      kind: 'buffer',
      ref: value,
      bytes: new Uint8Array(value.slice(0)),
      extra: extrasOf(value, () => false, seen),
    };
  if (value instanceof URLSearchParams)
    return { kind: 'params', ref: value, query: value.toString(), extra: extrasOf(value, () => false, seen) };
  if (isPlain(value)) {
    const snap: Snap = { kind: 'object', ref: value, allKeys: Reflect.ownKeys(value), data: [] };
    seen.set(value, snap);
    for (const key of snap.allKeys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc)) continue;
      // writable props are restored by reassignment; non-writable ones (behind
      // Object.freeze) cannot be reassigned, but their MUTABLE children can still
      // be restored in place — so snapshot them too
      snap.data.push([key, snapshot(desc.value, seen)]);
    }
    return snap;
  }
  // class instances, streams, spies — restored by reference; their internals are theirs
  return { kind: 'value', value };
}

function refOf(snap: Snap): unknown {
  return snap.kind === 'value' ? snap.value : snap.ref;
}

function restoreSnap(snap: Snap, seen = new Set<Snap>()): unknown {
  if (snap.kind === 'value') return snap.value;
  if (seen.has(snap)) return refOf(snap);
  seen.add(snap);
  if (snap.kind === 'array') {
    // a frozen (or sealed/readonly-slot) array is file state: leave it untouched
    if (Object.isFrozen(snap.ref)) return snap.ref;
    const items = snap.items.map((item) =>
      item.present ? { present: true, value: restoreSnap(item.snap, seen) } : { present: false, value: undefined },
    );
    snap.ref.length = items.length;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.present) snap.ref[index] = item.value;
    }
    // also removes indices a test added (e.g. it filled a hole in a seeded array)
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'map') {
    const entries = snap.entries.map(([key, item]) => [restoreSnap(key, seen), restoreSnap(item, seen)] as const);
    snap.ref.clear();
    for (const [key, item] of entries) snap.ref.set(key, item);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'set') {
    const items = snap.items.map((item) => restoreSnap(item, seen));
    snap.ref.clear();
    for (const item of items) snap.ref.add(item);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'date') {
    snap.ref.setTime(snap.time);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'bytes') {
    new Uint8Array(snap.ref.buffer, snap.ref.byteOffset, snap.ref.byteLength).set(snap.bytes);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'buffer') {
    new Uint8Array(snap.ref).set(snap.bytes);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  if (snap.kind === 'params') {
    for (const key of [...snap.ref.keys()]) snap.ref.delete(key);
    for (const [key, value] of new URLSearchParams(snap.query)) snap.ref.append(key, value);
    restoreExtras(snap.ref, snap.extra, seen);
    return snap.ref;
  }
  for (const key of Reflect.ownKeys(snap.ref)) {
    if (snap.allKeys.includes(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(snap.ref, key);
    if (!desc || desc.configurable === false) continue;
    delete snap.ref[key];
  }
  for (const [key, item] of snap.data) {
    const desc = Object.getOwnPropertyDescriptor(snap.ref, key);
    const value = restoreSnap(item, seen);
    if (!desc) {
      // a test deleted this key: put it back
      snap.ref[key] = value;
      continue;
    }
    if (!('value' in desc)) continue;
    if (desc.writable === true) snap.ref[key] = value;
    // non-writable (frozen): the prop stays, its object contents were restored in place
  }
  return snap.ref;
}

/** wrap `vi.hoisted` so every holder it returns is registered for restoration */
export function installHoistedIsolation(): void {
  const api = vi as unknown as { hoisted: <T>(factory: () => T) => T };
  const original = api.hoisted.bind(vi);
  api.hoisted = (<T>(factory: () => T): T => {
    const value = original(factory);
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) holders.push(value);
    return value;
  }) as typeof api.hoisted;

  beforeEach((context) => {
    pending.set(
      context.task.id,
      holders.map((holder) => snapshot(holder)),
    );
  });

  afterEach((context) => {
    const snaps = pending.get(context.task.id);
    if (!snaps) return;
    for (const snap of snaps) restoreSnap(snap);
    pending.delete(context.task.id);
  });
}

/** test-only introspection: how many holders this file registered */
export function registeredHolderCount(): number {
  return holders.length;
}
