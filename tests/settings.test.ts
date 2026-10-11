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

  it('getSettings defaults disablePasswordLogin false + companyName Tandem', async () => {
    expect(await getSettings()).toEqual({ disablePasswordLogin: false, companyName: 'Tandem' })
  })

  it('getSettings reflects a stored true flag', async () => {
    await setSetting('disablePasswordLogin', 'true')
    expect(await getSettings()).toEqual({ disablePasswordLogin: true, companyName: 'Tandem' })
  })

  it('companyName round-trips via setSetting and trims on read', async () => {
    await setSetting('companyName', '  Ultranomic  ')
    const s = await getSettings()
    expect(s.companyName).toBe('Ultranomic')
  })

  it('companyName undefined in update leaves the stored value untouched', async () => {
    const { buildServerContext, router } = await import('../server/utils/orpc')
    await setSetting('companyName', 'Kept Name')
    const ctx = buildServerContext(new Headers())
    ;(ctx as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: { id: 'u1', name: 'A', email: 'a@x', role: 'admin' } })
    const node = (router as any).settings.update['~orpc']
    await node.handler({ input: { disablePasswordLogin: false }, context: { ...ctx, session: { user: { id: 'u1', name: 'A', email: 'a@x', role: 'admin' } } }, signal: new AbortController().signal })
    expect((await getSettings()).companyName).toBe('Kept Name')
    // and with a value present it persists (trims)
    await node.handler({ input: { companyName: '  New Name  ' }, context: { ...ctx, session: { user: { id: 'u1', name: 'A', email: 'a@x', role: 'admin' } } }, signal: new AbortController().signal })
    expect((await getSettings()).companyName).toBe('New Name')
  })

  it('blank companyName falls back to Tandem', async () => {
    await setSetting('companyName', '   ')
    expect((await getSettings()).companyName).toBe('Tandem')
  })
})
