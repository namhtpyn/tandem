import { mountSuspended } from '@nuxt/test-utils/runtime';
// DataTable: desktop table + auto mobile card fallback from same column defs.
// The mounts below assert real elements (table/th, dl/dt) — matching on text
// alone passed even when the header row or the whole table was missing.
import { expect, it } from 'vitest';

import DataTable from '~/components/DataTable.vue';

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'env', header: 'Env' },
  { id: 'actions', header: '' },
];
const data = [{ id: '1', name: 'AWS key', env: 'prod' }];

it('renders a real desktop table with header cells', async () => {
  const c = await mountSuspended(DataTable, { props: { data, columns } });
  expect(c.find('table').exists()).toBe(true);
  const headers = c.findAll('th').map((th) => th.text());
  expect(headers).toContain('Name');
  expect(headers).toContain('Env');
  expect(c.text()).toContain('AWS key');
});

it('mobile fallback card shows title + labelled details, skips headerless columns', async () => {
  const c = await mountSuspended(DataTable, { props: { data, columns } });
  expect(c.text()).toContain('AWS key');
  expect(c.find('dl').exists()).toBe(true);
  expect(c.find('dt').text()).toBe('Env');
  expect(c.find('dd').text()).toBe('prod');
});

it('empty data with showEmptyState renders the branded empty state, not a table', async () => {
  const c = await mountSuspended(DataTable, {
    props: { data: [], columns, showEmptyState: true, emptyNoun: 'tasks', emptyText: 'Create the first one.' },
  });
  expect(c.find('table').exists()).toBe(false);
  expect(c.find('dl').exists()).toBe(false);
  expect(c.text()).toContain('No tasks yet');
  expect(c.text()).toContain('Create the first one.');
});

it('error state renders retry copy instead of a table', async () => {
  const c = await mountSuspended(DataTable, { props: { data: [], columns, error: true } });
  expect(c.text()).toContain("Couldn't load this list");
  expect(c.find('table').exists()).toBe(false);
});

it('a live search over empty rows says no results', async () => {
  const c = await mountSuspended(DataTable, {
    props: { data: [], columns, searchable: true, search: 'zzz', showEmptyState: true, emptyNoun: 'tasks' },
  });
  expect(c.text()).toContain('No results');
  expect(c.find('table').exists()).toBe(false);
});
