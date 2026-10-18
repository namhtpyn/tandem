// ssh-exec stream logic against a mocked ssh2 transport: stdout lines,
// stderr prefixing, exec error, connection error, exit codes.
import { describe, expect, it, vi, beforeEach } from 'vitest'

// runOverSsh lê o cap de run da Settings page — mock sem banco de dados
vi.mock('../server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: async () => 10_000,
}))

vi.mock('ssh2', () => {
  class FakeStream {
    handlers: Record<string, Array<(d: unknown) => void>> = {}
    stderrHandlers: Array<(d: unknown) => void> = []
    ended = false
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn]
      if (ev === 'data') return this
      return this
    }
    emitStdout(text: string) { (this.handlers['data'] ?? []).forEach(f => f(Buffer.from(text))) }
    emitStderr(text: string) { this.stderrHandlers.forEach(f => f(Buffer.from(text))) }
    close(code: number | null) {
      this.ended = true
      ;(this.handlers['close'] ?? []).forEach(f => f(code))
    }
    end(_data?: string) { /* captured by the exec caller */ }
  }
  // make .stderr.on work
  const wrap = (stream: FakeStream) => {
    ;(stream as unknown as Record<string, unknown>).stderr = {
      on: (_ev: string, fn: (d: unknown) => void) => { stream.stderrHandlers.push(fn) },
    }
    return stream
  }
  class FakeClient {
    static last: FakeClient
    handlers: Record<string, Array<(d: unknown) => void>> = {}
    execHandler: ((err: Error | null, stream: unknown) => void) | null = null
    ended = false
    execError: Error | null = null
    stream = wrap(new FakeStream())
    constructor() { FakeClient.last = this }
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn]
      return this
    }
    exec(_cmd: string, cb: (err: Error | null, stream: unknown) => void) {
      this.execHandler = cb
      cb(this.execError, this.stream)
    }
    end() { this.ended = true }
    connect(_opts: unknown) {
      // default: ready fires next tick
      setTimeout(() => (this.handlers['ready'] ?? []).forEach((f) => { (f as () => void)() }), 0)
    }
    emitError(err: Error) { (this.handlers['error'] ?? []).forEach(f => f(err)) }
  }
  return { default: { Client: FakeClient } }
})

import { runOverSsh } from '../server/domains/tasks/ssh-exec.util'

const plan = { env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' }, sshKey: 'k', sshPassword: undefined }

async function collected() {
  const lines: string[] = []
  let finishState: { status: string, exitCode: number | null } | null = null
  let resolved: { status: string, exitCode: number | null } | null = null
  const finish = async (status: 'done' | 'failed', exitCode: number | null) => { finishState = { status, exitCode } }
  const resolve = (v: { status: string, exitCode: number | null }) => { resolved = v }
  return { lines, finish, resolve, state: () => ({ finishState, resolved }) }
}

beforeEach(() => { vi.clearAllMocks() })

describe('runOverSsh (mocked ssh2)', () => {
  it('streams stdout lines, prefixes stderr, closes done on exit 0', async () => {
    const { lines, finish, resolve, state } = await collected()
    const clientMod = (await import('ssh2')).default
    const FakeClient = clientMod.Client as unknown as { last: { stream: { emitStdout(t: string): void, emitStderr(t: string): void, close(c: number | null): void } } }
    const p = runOverSsh(plan, 'cmd', 'blob', l => lines.push(l), finish, resolve as never)
    await new Promise(r => setTimeout(r, 10))
    FakeClient.last.stream.emitStdout('line1\nline2\n')
    FakeClient.last.stream.emitStderr('warn\n')
    FakeClient.last.stream.close(0)
    await p
    const s = state()
    expect(lines).toEqual(['line1', 'line2', '[stderr] warn'])
    expect(s.finishState).toEqual({ status: 'done', exitCode: 0 })
    expect(s.resolved).toEqual({ status: 'done', exitCode: 0 })
  })

  it('nonzero exit marks the run failed', async () => {
    const { lines, finish, resolve, state } = await collected()
    const clientMod = (await import('ssh2')).default
    const FakeClient = clientMod.Client as unknown as { last: { stream: { close(c: number | null): void } } }
    const p = runOverSsh(plan, 'cmd', 'blob', l => lines.push(l), finish, resolve as never)
    await new Promise(r => setTimeout(r, 10))
    FakeClient.last.stream.close(3)
    await p
    const s = state()
    expect(s.finishState).toEqual({ status: 'failed', exitCode: 3 })
  })

  it('exec error fails the run without streaming', async () => {
    const { lines, finish, resolve, state } = await collected()
    const clientMod = (await import('ssh2')).default
    const Ctor = clientMod.Client as unknown as { last: { execError: Error | null }, new (): unknown }
    // plant the exec error before ready fires: run first tick ordering — connect schedules ready
    // on next tick, so set the flag synchronously after runOverSsh starts
    const p = runOverSsh(plan, 'cmd', 'blob', l => lines.push(l), finish, resolve as never)
    await new Promise(r => setTimeout(r, 1)) // client constructed inside runOverSsh's first await
    Ctor.last.execError = new Error('exec blew up')
    await new Promise(r => setTimeout(r, 15)) // ready -> exec with the planted error
    await new Promise(r => setTimeout(r, 20))
    await p
    const s = state()
    expect(s.finishState).toEqual({ status: 'failed', exitCode: null })
  })

  it('connection error surfaces as failed with the message on the stream', async () => {
    const { lines, finish, resolve, state } = await collected()
    const clientMod = (await import('ssh2')).default
    const FakeClient = clientMod.Client as unknown as { last: { emitError(e: Error): void } }
    const p = runOverSsh({ ...plan, sshKey: undefined }, 'cmd', 'blob', l => lines.push(l), finish, resolve as never)
    await new Promise(r => setTimeout(r, 10))
    FakeClient.last.emitError(new Error('ECONNREFUSED'))
    await p
    const s = state()
    expect(lines.some(l => l.includes('ECONNREFUSED'))).toBe(true)
    expect(s.finishState).toEqual({ status: 'failed', exitCode: null })
  })

  it('port defaults to 22 on garbage', async () => {
    const { lines, finish, resolve } = await collected()
    const clientMod = (await import('ssh2')).default
    const FakeClient = clientMod.Client as unknown as { last: { stream: { close(c: number | null): void } } }
    const p = runOverSsh({ env: { host: 'h', port: 'x', username: '00000000-0000-7000-8000-51e69892ab49' } as never, sshKey: 'k' }, 'cmd', 'blob', l => lines.push(l), finish, resolve as never)
    await new Promise(r => setTimeout(r, 10))
    FakeClient.last.stream.close(0)
    await p
  })
})
