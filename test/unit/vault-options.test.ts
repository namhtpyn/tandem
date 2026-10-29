import { describe, expect, it } from 'vitest';

import { groupedSecretOptions, type VaultSecretOptionRow } from '../../app/utils/vault-options';

const row = (id: string, name: string, lastFour: string, folder: string | null): VaultSecretOptionRow => ({
  id,
  name,
  lastFour,
  folder,
});

describe('groupedSecretOptions', () => {
  it('groups by folder with headers first, loose secrets last under "No folder"', () => {
    const out = groupedSecretOptions([
      row('1', 'Zed key', 'abcd', 'Prod'),
      row('2', 'Jay key', 'ef12', ''),
      row('3', 'Ash key', '9f3e', 'Prod'),
      row('4', 'Loose key', '', null),
    ]);
    expect(out).toEqual([
      { label: 'Prod', type: 'label' },
      { label: 'Ash key (•••• 9f3e)', value: '3' },
      { label: 'Zed key (•••• abcd)', value: '1' },
      { label: 'No folder', type: 'label' },
      { label: 'Jay key (•••• ef12)', value: '2' },
      { label: 'Loose key', value: '4' },
    ]);
  });

  it('omits the last-four suffix when empty and sorts by name inside a group', () => {
    const out = groupedSecretOptions([row('b', 'beta', '', 'F'), row('a', 'alpha', '1111', 'F')]);
    expect(out.map((o) => o.label)).toEqual(['F', 'alpha (•••• 1111)', 'beta']);
  });

  it('returns [] for no secrets', () => {
    expect(groupedSecretOptions([])).toEqual([]);
  });
});
