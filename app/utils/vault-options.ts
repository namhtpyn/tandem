// Vault secret picker options grouped by folder. Shared by every "pick a secret"
// select in the app — environments (SSH keys), employees (AI API keys) and
// settings (workspace AI assignments).
export type VaultSecretOptionRow = {
  id: string
  name: string
  lastFour: string
  folder: string | null
}

type FlatOption = { label: string, value: string }

/** flat list -> USelectMenu items with folder headers (type:'label'), folders first */
export function groupedSecretOptions(rows: VaultSecretOptionRow[]): Array<FlatOption | { label: string, type: 'label' }> {
  const label = (s: VaultSecretOptionRow) => `${s.name}${s.lastFour ? ` (•••• ${s.lastFour})` : ''}`
  const byFolder = new Map<string, FlatOption[]>()
  for (const s of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = s.folder ?? ''
    const arr = byFolder.get(key) ?? []
    arr.push({ label: label(s), value: s.id })
    byFolder.set(key, arr)
  }
  const out: Array<FlatOption | { label: string, type: 'label' }> = []
  const folders = [...byFolder.keys()].filter(k => k !== '').sort((a, b) => a.localeCompare(b))
  for (const f of folders) {
    out.push({ label: f, type: 'label' })
    out.push(...byFolder.get(f)!)
  }
  const loose = byFolder.get('')
  if (loose?.length) {
    out.push({ label: 'No folder', type: 'label' })
    out.push(...loose)
  }
  return out
}
