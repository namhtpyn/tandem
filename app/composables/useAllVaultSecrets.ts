import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';
import type { VaultSecretRow } from '~/utils/orpc-types';

// Vault picker source for surfaces that must offer EVERY secret (employee
// editor, environments, settings): a single page caps at 100 rows and would
// silently hide the rest of the vault, so walk pages up to `total`. One shared
// [VAULT, 'all'] cache key — one walk per vault state, deduped across consumers.
const WALK_PAGE_SIZE = 100;
/** safety cap: 20 pages = 2000 secrets — past that the picker truncates instead of hammering the API */
const WALK_MAX_PAGES = 20;

export function useAllVaultSecrets() {
  const { $orpc } = useNuxtApp();
  return useQuery({
    queryKey: [CHANGE_RESOURCE.VAULT, 'all'],
    queryFn: async (): Promise<VaultSecretRow[]> => {
      const first = await $orpc.vault.secrets.list.call({ page: 1, pageSize: WALK_PAGE_SIZE });
      const rows = [...first.data];
      const pages = Math.min(WALK_MAX_PAGES, Math.ceil(first.total / WALK_PAGE_SIZE));
      for (let p = 2; p <= pages; p++) {
        const next = await $orpc.vault.secrets.list.call({ page: p, pageSize: WALK_PAGE_SIZE });
        rows.push(...next.data);
      }
      return rows;
    },
  });
}
