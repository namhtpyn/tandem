// TEXT-STORABILITY LAW (#382, SPEC "API law"): a legal astral secret must not
// corrupt its own stored hint. `lastFourHint` slices by code points, and this
// pin runs the REAL vault service so a caller that reintroduces a raw
// `value.slice(-4)` (the pre-fix bug) turns it red — the helper-only pin would
// stay green.
import { describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const inserted: Row[] = [];
const updated: Row[] = [];

vi.mock('../../server/db/index', () => {
  const nextRow = (values: Row): Row => ({
    id: 'row-id',
    lastFour: '',
    createdBy: null,
    folderId: null,
    ...values,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    db: {
      insert: () => ({
        values: (values: Row) => ({
          returning: async () => {
            inserted.push(values);
            return [nextRow(values)];
          },
        }),
      }),
      update: () => ({
        set: (values: Row) => ({
          where: () => ({
            returning: async () => {
              updated.push(values);
              return [nextRow(values)];
            },
          }),
        }),
      }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
      query: { vaultFolders: { findFirst: async () => null } },
      delete: () => ({ where: async () => undefined }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', () => ({
  ORPCError: class extends Error {
    code: string;
    constructor(code: string, options: { message: string }) {
      super(options.message);
      this.code = code;
    }
  },
  publishChange: async () => undefined,
}));

import { createSecret, updateSecret } from '../../server/domains/vault/secret/secret.service';

describe('vault secret writes store a code-point-safe last-four hint (#382)', () => {
  it('create stores the astral-safe hint, never a lone surrogate', async () => {
    await createSecret({ name: 'n', description: '', value: '12345😀abc', folderId: null }, 'actor');
    expect(inserted.at(-1)?.lastFour).toBe('😀abc');
  });

  it('a rotation stores the same safe hint', async () => {
    await updateSecret({ id: 'row-id', name: 'n', description: '', value: '12345😀abc', folderId: null }, 'actor');
    expect(updated.at(-1)?.lastFour).toBe('😀abc');
  });

  it('a metadata-only update leaves the stored hint alone', async () => {
    await updateSecret({ id: 'row-id', name: 'n2', description: '', folderId: null }, 'actor');
    const row = updated.at(-1);
    // a dropped metadata-only write would also leave `lastFour` undefined —
    // assert the row was actually written AND the hint key is absent
    expect(row).toBeDefined();
    expect(row).toMatchObject({ name: 'n2' });
    expect(Object.prototype.hasOwnProperty.call(row, 'lastFour')).toBe(false);
  });
});
