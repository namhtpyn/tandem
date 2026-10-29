import { nonNull } from '#shared/utils/non-null';

// Vault secret picker options grouped by folder. Shared by every "pick a secret"
// select in the app — environments (SSH keys), employees (AI API keys) and
// settings (workspace AI assignments).
export type VaultSecretOptionRow = {
  id: string;
  name: string;
  lastFour: string;
  folder: string | null;
};

export type FlatOption = { label: string; value: string };
export type SecretOption = FlatOption | { label: string; type: 'label'; value?: undefined };

/* v8 ignore next -- bun's v8 remap drops the execution count for module-scope
 * sort comparators (line runs, fn count stays 0; owner ruling 2026-10-27: (b)) */
function byName(a: string, b: string) {
  return a.localeCompare(b);
}

/** flat list -> USelectMenu items with folder headers (type:'label'), folders first */
export function groupedSecretOptions(rows: VaultSecretOptionRow[]): SecretOption[] {
  const label = (s: VaultSecretOptionRow) => `${s.name}${s.lastFour ? ` (•••• ${s.lastFour})` : ''}`;
  const byFolder = new Map<string, FlatOption[]>();
  for (const s of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = s.folder ?? '';
    const arr = byFolder.get(key) ?? [];
    arr.push({ label: label(s), value: s.id });
    byFolder.set(key, arr);
  }
  const out: SecretOption[] = [];
  // plain loop, not .filter(fn): bun's v8 remap counts the inline arrow as an
  // uncovered function even when it runs (gate-fn artifact)
  const folders: string[] = [];
  for (const k of byFolder.keys()) if (k !== '') folders.push(k);
  folders.sort(byName);
  for (const f of folders) {
    out.push({ label: f, type: 'label' });
    out.push(...nonNull(byFolder.get(f)));
  }
  const loose = byFolder.get('');
  if (loose?.length) {
    out.push({ label: 'No folder', type: 'label' });
    out.push(...loose);
  }
  return out;
}
