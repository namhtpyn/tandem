// app/composables/useAppSession — useState-backed session/config/version state
// and the focus-refresh lifecycle. happy-dom environment; Nuxt auto-imports
// (useState, onMounted…) are stubbed globally in this file's harness.
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ---- Nuxt runtime stubs ----
type Ref<T> = { value: T }
const stateStore = new Map<string, Ref<unknown>>()
function useStateStub<T>(key: string, init: () => T): Ref<T> {
  if (!stateStore.has(key)) stateStore.set(key, { value: init() })
  return stateStore.get(key) as Ref<T>
}

const mounted: Array<() => void> = []
const unmounted: Array<() => void> = []
let currentFetch: ((url: string) => Promise<unknown>) | null = null

const g = globalThis as Record<string, unknown>
g.useState = useStateStub
g.onMounted = (fn: () => void) => mounted.push(fn)
g.onUnmounted = (fn: () => void) => unmounted.push(fn)
g.$fetch = (url: string) => currentFetch?.(url)

beforeEach(() => {
  stateStore.clear()
  mounted.length = 0
  unmounted.length = 0
  currentFetch = null
})

describe('useAppSession', () => {
  it('defaults: null session, null auth-config, dev version', async () => {
    const m = await import('../app/composables/useAppSession')
    expect(m.useAppSession().value).toBeNull()
    expect(m.useAuthConfigState().value).toBeNull()
    expect(m.useAppVersion().value).toBe('dev')
  })

  it('shares one state instance per key', async () => {
    const m = await import('../app/composables/useAppSession')
    m.useAppSession().value = { user: { id: 'x', name: 'X', email: 'x@x', role: 'admin' }, session: { expiresAt: 'later' } }
    expect(m.useAppSession().value?.user.id).toBe('x')
  })
})

describe('useSessionRefreshing', () => {
  it('refreshSession updates the session from /api/auth-session', async () => {
    currentFetch = async (url) => {
      if (url === '/api/auth-session') return { user: { id: 'u1', name: 'U', email: 'u@x', role: 'viewer' }, session: { expiresAt: 't' } }
      throw new Error(`unexpected fetch ${url}`)
    }
    const m = await import('../app/composables/useAppSession')
    const { refreshSession } = m.useSessionRefreshing()
    await refreshSession()
    expect(m.useAppSession().value?.user.id).toBe('u1')
  })

  it('refreshSession swallows fetch errors and nulls the session', async () => {
    currentFetch = async () => { throw new Error('network down') }
    const m = await import('../app/composables/useAppSession')
    m.useAppSession().value = { user: { id: 'old', name: 'O', email: 'o@x', role: 'admin' }, session: { expiresAt: 't' } }
    const { refreshSession } = m.useSessionRefreshing()
    await expect(refreshSession()).resolves.toBeUndefined()
    expect(m.useAppSession().value).toBeNull()
  })

  it('sees import.meta.client as true under the define', async () => {
    const probe = await import('../app/composables/useAppSession')
    // if define worked, useSessionRefreshing registers lifecycle hooks; assert via side effect
    const before = mounted.length
    probe.useSessionRefreshing()
    expect(mounted.length).toBeGreaterThan(before)
  })

  it('registers window focus listener on mount and removes it on unmount', async () => {
    const add = vi.fn()
    const remove = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = { addEventListener: add, removeEventListener: remove }
    const m = await import('../app/composables/useAppSession')
    m.useSessionRefreshing()
    expect(mounted).toHaveLength(1)
    mounted[0]!()
    expect(add).toHaveBeenCalledWith('focus', expect.any(Function))
    unmounted[0]!()
    expect(remove).toHaveBeenCalledWith('focus', expect.any(Function))
  })
})
