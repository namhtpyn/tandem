// Remaining branch arms for full coverage: rpc adapter GET/no-body arms and
// ssh-probe node fallback (spawn error + null exit code).
import { describe, expect, it, beforeEach, vi } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { makeEvent } from './api-harness'

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
})

describe('/rpc adapter branch arms', () => {
  it('GET with no body builds a bodyless Request (live SSE endpoint)', async () => {
    const mod = await import('../server/routes/rpc/[...]')
    const event = makeEvent({ method: 'GET', url: '/rpc/health-nope' })
    const res = await mod.default(event)
    expect(res).toBe('Not found') // GET outside router -> 404 text arm
  })

  it('undefined url falls back to "/" and object bodies get stringified', async () => {
    const mod = await import('../server/routes/rpc/[...]')
    const event = makeEvent({ method: 'POST', url: undefined, headers: { 'content-type': 'application/json' } })
    ;(event.node.req as { body?: unknown }).body = { json: { nope: 1 } } // object -> JSON.stringify arm
    const res = await mod.default(event)
    expect(res).toBe('Not found') // url '/' -> no procedure match -> text arm
  })
})

describe('pickFailureDetail', () => {
  it('prefers a real bun shell error over the node error', async () => {
    const { pickFailureDetail } = await import('../server/utils/ssh-probe')
    expect(pickFailureDetail(new Error('shell exploded'), new Error('node fail'))).toBe('shell exploded')
  })

  it('falls back to the node error when bun is unavailable', async () => {
    const { pickFailureDetail } = await import('../server/utils/ssh-probe')
    expect(pickFailureDetail(new Error("Cannot find package 'bun'"), new Error('node fail'))).toBe('node fail')
  })

  it('degrades to a generic message for non-Error throws', async () => {
    const { pickFailureDetail } = await import('../server/utils/ssh-probe')
    expect(pickFailureDetail('nope', 'also nope')).toBe('probe failed')
  })
})

describe('ssh-probe probeViaNode (mocked child_process)', () => {
  it('timeout path: timer kills a hung child (null exit)', async () => {
    process.env.TANDEM_SSH_TIMEOUT_MS = '50'
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const mkStream = () => {
          const l: Record<string, Array<(...a: unknown[]) => void>> = {}
          return { on: (ev: string, fn: (...a: unknown[]) => void) => { (l[ev] ??= []).push(fn) }, fire: () => { for (const fn of l.end ?? []) fn() } }
        }
        const procL: Record<string, Array<(...a: unknown[]) => void>> = {}
        const child = {
          stdout: mkStream(),
          stderr: mkStream(),
          kill: () => { child.stdout.fire(); child.stderr.fire(); for (const fn of procL.close ?? []) fn(null) },
          on: (ev: string, fn: (...a: unknown[]) => void) => { (procL[ev] ??= []).push(fn) },
        }
        return child
      },
    }))
    try {
      const mod = await import('../server/utils/ssh-probe')
      const r = await mod.probeSsh('h', '22', 'u')
      expect(r.ok).toBe(false)
    }
    finally {
      delete process.env.TANDEM_SSH_TIMEOUT_MS
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }, 10_000)

  it('killed child (null exit) with stderr -> ok:false, last stderr line', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const mkStream = (data: string | null) => {
          const l: Record<string, Array<(...a: unknown[]) => void>> = {}
          return {
            on: (ev: string, fn: (...a: unknown[]) => void) => { (l[ev] ??= []).push(fn) },
            fire: () => {
              if (data !== null) for (const fn of l.data ?? []) fn(Buffer.from(data))
              for (const fn of l.end ?? []) fn()
            },
          }
        }
        const out = mkStream('partial-output')
        const err = mkStream('first\nssh: killed by timeout')
        const procL: Record<string, Array<(...a: unknown[]) => void>> = {}
        const child = {
          stdout: out,
          stderr: err,
          kill: () => {},
          on: (ev: string, fn: (...a: unknown[]) => void) => { (procL[ev] ??= []).push(fn) },
        }
        setTimeout(() => {
          out.fire()
          err.fire()
          for (const fn of procL.close ?? []) fn(null)
        }, 5)
        return child
      },
    }))
    try {
      const mod = await import('../server/utils/ssh-probe')
      const r = await mod.probeSsh('h', '22', 'u')
      expect(r).toEqual({ ok: false, detail: 'ssh: killed by timeout' })
    }
    finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }, 10_000)

  it('interprets a successful ssh run end-to-end', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const mkStream = (data: string | null) => {
          const l: Record<string, Array<(...a: unknown[]) => void>> = {}
          return {
            on: (ev: string, fn: (...a: unknown[]) => void) => { (l[ev] ??= []).push(fn) },
            fire: () => {
              if (data !== null) for (const fn of l.data ?? []) fn(Buffer.from(data))
              for (const fn of l.end ?? []) fn()
            },
          }
        }
        const out = mkStream('tandem-probe-ok')
        const err = mkStream('ssh: banner warning')
        const procL: Record<string, Array<(...a: unknown[]) => void>> = {}
        const child = {
          stdout: out,
          stderr: err,
          kill: () => {},
          on: (ev: string, fn: (...a: unknown[]) => void) => { (procL[ev] ??= []).push(fn) },
        }
        setTimeout(() => {
          out.fire()
          err.fire()
          for (const fn of procL.close ?? []) fn(0)
        }, 5)
        return child
      },
    }))
    try {
      const mod = await import('../server/utils/ssh-probe')
      const r = await mod.probeSsh('h', '22', 'u')
      // marker echoed + exit 0 -> ok even with stderr noise
      expect(r).toEqual({ ok: true, detail: 'SSH key auth works' })
    }
    finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }, 10_000)
})

describe('ssh-probe node fallback arms', () => {
  it('non-Error throw surfaces generic detail', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: () => { throw 'plain string failure' },
    }))
    try {
      const mod = await import('../server/utils/ssh-probe')
      const r = await mod.probeSsh('127.0.0.1', '22', 'u')
      expect(r.ok).toBe(false)
      expect(typeof r.detail).toBe('string')
    }
    finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('bun')
      vi.resetModules()
    }
  }, 10_000)
})
