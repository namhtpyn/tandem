// DataTable: desktop table + auto mobile card fallback from same column defs
import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DataTable from '~/components/DataTable.vue'

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'env', header: 'Env' },
  { id: 'actions', header: '' },
]
const data = [{ id: '1', name: 'AWS key', env: 'prod' }]

it('renders table headers on desktop branch', async () => {
  const c = await mountSuspended(DataTable, { props: { data, columns } })
  const text = c.text()
  expect(text).toContain('Name')
  expect(text).toContain('AWS key')
})

it('mobile fallback card shows title + labelled details, skips headerless columns', async () => {
  const c = await mountSuspended(DataTable, { props: { data, columns } })
  expect(c.text()).toContain('AWS key')
  expect(c.find('dl').exists()).toBe(true)
  expect(c.find('dt').text()).toBe('Env')
  expect(c.find('dd').text()).toBe('prod')
})

it('empty data renders neither branch', async () => {
  const c = await mountSuspended(DataTable, { props: { data: [], columns } })
  expect(c.find('table').exists()).toBe(false)
  expect(c.find('dl').exists()).toBe(false)
})
