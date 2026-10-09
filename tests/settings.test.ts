// settings store: get/set/delete + typed getSettings
import { describe, expect, it } from 'vitest'
import './helpers/pg'
import { getSetting, setSetting, deleteSetting, getSettings } from '../server/utils/settings'
import { postgres } from './helpers/pg'

describe('settings store', () => {
  it('returns null for a missing key', async () => {
    expect(await getSetting('nope')).toBeNull()
  })

  it('set then get round-trips a value', async () => {
    await setSetting('k1', 'v1')
    expect(await getSetting('k1')).toBe('v1')
  })

  it('set twice updates in place (upsert)', async () => {
    await setSetting('k2', 'first')
    await setSetting('k2', 'second')
    expect(await getSetting('k2')).toBe('second')
    const rows = await postgres`select count(*)::int as n from tandem_settings where key = 'k2'`
    expect(rows[0]!.n).toBe(1)
  })

  it('deleteSetting removes the row', async () => {
    await setSetting('k3', 'v3')
    await deleteSetting('k3')
    expect(await getSetting('k3')).toBeNull()
  })

  it('getSettings defaults disablePasswordLogin false', async () => {
    expect(await getSettings()).toEqual({ disablePasswordLogin: false })
  })

  it('getSettings reflects a stored true flag', async () => {
    await setSetting('disablePasswordLogin', 'true')
    expect(await getSettings()).toEqual({ disablePasswordLogin: true })
  })
})
