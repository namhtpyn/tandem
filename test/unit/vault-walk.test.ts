// useAllVaultSecrets — the whole-vault walker. useQuery is stubbed so the test
// drives queryFn directly; the $orpc seam comes from the useNuxtApp stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let listCalls: Array<{ page: number; pageSize: number }> = [];
let pages: Record<number, { data: Array<{ id: string }>; total: number }> = {};

vi.mock('@tanstack/vue-query', () => ({
  useQuery: (opts: { queryFn: () => Promise<unknown> }) => ({ data: opts.queryFn() }),
}));

const g = globalThis as Record<string, unknown>;
g.useNuxtApp = () => ({
  $orpc: {
    vault: {
      secrets: {
        list: {
          call: async (input: { page: number; pageSize: number }) => {
            listCalls.push(input);
            return pages[input.page] ?? { data: [], total: pages[1]?.total ?? 0 };
          },
        },
      },
    },
  },
});

beforeEach(() => {
  listCalls = [];
  pages = {};
});

function rows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${offset + i}` }));
}

describe('useAllVaultSecrets', () => {
  it('returns a single page untouched when the vault fits one page', async () => {
    pages[1] = { data: rows(3), total: 3 };
    const m = await import('../../app/composables/useAllVaultSecrets.ts');
    const out = (await m.useAllVaultSecrets().data) as unknown as Array<{ id: string }>;
    expect(out.map((r) => r.id)).toEqual(['s0', 's1', 's2']);
    expect(listCalls).toEqual([{ page: 1, pageSize: 100 }]);
  });

  it('walks every page up to total', async () => {
    pages[1] = { data: rows(100), total: 250 };
    pages[2] = { data: rows(100, 100), total: 250 };
    pages[3] = { data: rows(50, 200), total: 250 };
    const m = await import('../../app/composables/useAllVaultSecrets.ts');
    const out = (await m.useAllVaultSecrets().data) as unknown as Array<{ id: string }>;
    expect(out).toHaveLength(250);
    expect(listCalls.map((c) => c.page)).toEqual([1, 2, 3]);
  });

  it('caps the walk at the safety limit instead of hammering the API', async () => {
    pages[1] = { data: rows(100), total: 5000 };
    for (let p = 2; p <= 25; p++) pages[p] = { data: rows(100, (p - 1) * 100), total: 5000 };
    const m = await import('../../app/composables/useAllVaultSecrets.ts');
    const out = (await m.useAllVaultSecrets().data) as unknown as Array<{ id: string }>;
    expect(listCalls).toHaveLength(20);
    expect(out).toHaveLength(2000);
  });
});
