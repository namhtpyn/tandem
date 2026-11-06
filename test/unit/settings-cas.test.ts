// setSettingIfUnchanged (r6 review): the channels base check must be ONE
// conditional statement — no read-then-write window. Pinned at the service
// with fake executors (no-real-DB law: the executor is passed in, the default
// db is never queried): the WHERE must carry key + base updatedAt, the
// null-base path must be insert-or-nothing (never an unconditional write).
import { describe, expect, it } from 'vitest';

import { setSettingIfUnchanged } from '../../server/domains/settings/settings.service';

function fakeEx(rows: unknown[]): { ex: never; conds: unknown[] } {
  const conds: unknown[] = [];
  const ex = {
    update: () => ({
      set: () => ({
        where: (cond: unknown) => {
          conds.push(cond);
          return { returning: async () => rows };
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => rows,
        }),
      }),
    }),
  };
  return { ex: ex as never, conds };
}

describe('setSettingIfUnchanged (atomic CAS writer)', () => {
  /** drizzle conditions nest (and → conditions) — walk the tree, depth-capped */
  function columnNames(node: unknown, depth = 0, acc: Set<string> = new Set()): Set<string> {
    if (node === null || typeof node !== 'object' || depth > 8) return acc;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'name' && typeof v === 'string') acc.add(v);
      else if (v !== null && typeof v === 'object') columnNames(v, depth + 1, acc);
    }
    return acc;
  }

  it('the where predicate carries key AND base updatedAt (conditional commit)', async () => {
    const { ex, conds } = fakeEx([{ key: 'channels' }]);
    await expect(setSettingIfUnchanged('channels', '[]', '2026-01-02T00:00:00.000Z', ex)).resolves.toBe(true);
    const names = columnNames(conds[0]);
    expect(names).toContain('key');
    expect(names).toContain('updated_at');
  });

  it('zero rows matched (base drifted) -> false, caller refuses', async () => {
    const { ex } = fakeEx([]);
    await expect(setSettingIfUnchanged('channels', '[]', '2026-01-02T00:00:00.000Z', ex)).resolves.toBe(false);
  });

  it('null base = INSERT-or-nothing (a row that appeared under us refuses)', async () => {
    const inserted = fakeEx([{ key: 'channels' }]);
    await expect(setSettingIfUnchanged('channels', '[]', null, inserted.ex)).resolves.toBe(true);
    expect(inserted.conds).toHaveLength(0); // took the INSERT arm, not a blind update
    const conflict = fakeEx([]); // onConflictDoNothing returning 0 rows = row existed
    await expect(setSettingIfUnchanged('channels', '[]', null, conflict.ex)).resolves.toBe(false);
  });

  it('a garbage base refuses without touching the db', async () => {
    const { ex, conds } = fakeEx([{ key: 'channels' }]);
    await expect(setSettingIfUnchanged('channels', '[]', 'not-a-date', ex)).resolves.toBe(false);
    expect(conds).toHaveLength(0);
  });
});
