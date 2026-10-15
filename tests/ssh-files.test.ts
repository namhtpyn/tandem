// ssh-files.util shuttle against a scripted fake ssh2 Client (no network).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTaskFiles, collectRunOutputs, pushTaskFiles, TASK_FILES_HOME, taskFilesOutDir, type SshFilePlan } from '../server/domains/tasks/ssh-files.util'

class FakeStream {
  private stderrCb: ((d: Buffer) => void) | null = null
  stderr = {
    on: (_ev: string, cb: (d?: Buffer) => void) => {
      this.stderrCb = cb as (d: Buffer) => void
      queueMicrotask(() => this.stderrCb?.(Buffer.from('warn')))
      return this
    },
  }
  on(ev: string, cb: (d?: Buffer) => void) {
    if (ev === 'data') queueMicrotask(() => cb(Buffer.from((this as unknown as { __out: string }).__out ?? '')))
    if (ev === 'close') queueMicrotask(() => cb())
    return this
  }
  end() {}
  get stderr() { return { on: () => {} } }
}

/** Fake ssh2 Client: records commands, answers exec by script */
function makeFakeClient(script: Record<string, string>) {
  const cmds: string[] = []
  const instances: Array<{ __cmds: string[] }> = []
  class FakeClient {
    constructor() { instances.push(this) }
    private handlers = new Map<string, Array<(arg?: unknown) => void>>()
    connect(_opts: unknown) {
      queueMicrotask(() => this.emit('ready'))
      return this
    }
    on(ev: string, cb: (arg?: unknown) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]); return this }
    private emit(ev: string, arg?: unknown) { for (const cb of this.handlers.get(ev) ?? []) cb(arg) }
    end() { this.emit('close') }
    exec(cmd: string, cb: (err: Error | null, stream: unknown) => void) {
      cmds.push(cmd)
      const hit = Object.keys(script).find(k => cmd.startsWith(k))
      const stream = Object.assign(new FakeStream(), { __out: hit ? script[hit]! : '' })
      cb(null, stream)
    }
    sftp(cb: (err: Error | null, sftp: unknown) => void) {
      const putFiles: Array<[string, string]> = []
      const gotFiles: Array<[string, string]> = []
      cb(null, {
        fastPut: (local: string, remote: string, done: (e?: Error | null) => void) => { putFiles.push([local, remote]); done(null) },
        fastGet: (remote: string, local: string, done: (e?: Error | null) => void) => {
          gotFiles.push([remote, local])
          writeFileSync(local, 'FROM-SANDBOX')
          done(null)
        },
        __putFiles: putFiles,
        __gotFiles: gotFiles,
      })
    }
    __cmds = cmds
  }
  const Ctor = FakeClient as unknown as typeof import('ssh2').Client & { __instances: typeof instances }
  Object.defineProperty(Ctor, '__instances', { value: instances })
  return Ctor
}

const plan: SshFilePlan = { env: { host: 'sbx.test', port: '2222', username: 'root' }, sshPassword: 'pw' }

describe('connect timeout', () => {
  it('rejects when the sandbox never becomes ready', async () => {
    class DeadClient {
      connect() { return this }
      on() { return this }
      end() {}
    }
    await expect(pushTaskFiles(DeadClient as unknown as typeof import('ssh2').Client, plan, 'tx', [{ localPath: '/nonexistent', remoteName: 'x' }], 30))
      .rejects.toThrow('sftp connect timeout')
  })
})

describe('connect timeout', () => {
  it('swallows end() failures while timing out', async () => {
    class RudeClient {
      connect() { return this }
      on() { return this }
      end() { throw new Error('already destroyed') }
    }
    await expect(cleanupTaskFiles(RudeClient as unknown as typeof import('ssh2').Client, plan, 'tz', 20))
      .rejects.toThrow('sftp connect timeout')
  })
})

describe('pushTaskFiles', () => {
  it('no-ops with no files (never connects)', async () => {
    const Fake = makeFakeClient({})
    await pushTaskFiles(Fake, plan, 't-empty', [])
    const inst = (Fake as unknown as { __instances: Array<unknown> }).__instances
    expect(inst.length).toBe(0)
  })

  it('mkdir + fastPut each file + chown, then closes', async () => {
    const Fake = makeFakeClient({ 'mkdir -p': '' })
    const tmp = mkdtempSync(join(tmpdir(), 'push-'))
    writeFileSync(join(tmp, 'a.png'), 'PNG')
    await pushTaskFiles(Fake, plan, 't1', [{ localPath: join(tmp, 'a.png'), remoteName: 'a.png' }])
    const all = (Fake as unknown as { __instances: Array<{ __cmds: string[] }> }).__instances.flatMap(i => i.__cmds)
    expect(all.some(c => c.startsWith('mkdir -p'))).toBe(true)
    expect(all.some(c => c.includes('chown -R 10000:10000'))).toBe(true)
  })
})

describe('collectRunOutputs', () => {
  it('lists out/ via find, size-checks with du, fastGets each file', async () => {
    const Fake = makeFakeClient({
      [`find ${taskFilesOutDir('t2')}`]: 'report.md\nchart.png',
      [`du -cb '${taskFilesOutDir('t2')}/report.md' '${taskFilesOutDir('t2')}/chart.png'`]: '1024\ttotal',
    })
    const tmp = mkdtempSync(join(tmpdir(), 'collect-'))
    const got = await collectRunOutputs(Fake, plan, 't2', tmp, 50 * 1024 * 1024)
    expect(got.map(g => g.filename).sort()).toEqual(['chart.png', 'report.md'])
    expect(got.every(g => g.size > 0)).toBe(true)
  })
  it('returns nothing when out/ is empty', async () => {
    const Fake = makeFakeClient({ [`find ${taskFilesOutDir('t3')}`]: '' })
    const got = await collectRunOutputs(Fake, plan, 't3', mkdtempSync(join(tmpdir(), 'collect-')), 1024)
    expect(got).toEqual([])
  })
  it('refuses to collect over the size cap', async () => {
    const Fake = makeFakeClient({
      [`find ${taskFilesOutDir('t4')}`]: 'big.bin',
      [`du -cb '${taskFilesOutDir('t4')}/big.bin'`]: '999999999\ttotal',
    })
    const got = await collectRunOutputs(Fake, plan, 't4', mkdtempSync(join(tmpdir(), 'collect-')), 1000)
    expect(got).toEqual([])
  })
})

describe('transfer error arms', () => {
  it('propagates fastPut failures out of pushTaskFiles', async () => {
    const Fake = makeFakeClient({ 'mkdir -p': '' })
    // sabotage sftp: force fastPut error
    class FailingSftpClient {
      private h = new Map<string, Array<(a?: unknown) => void>>()
      constructor() { void 0 }
      connect() { queueMicrotask(() => this.emit('ready')); return this }
      on(ev: string, cb: (a?: unknown) => void) { this.h.set(ev, [...(this.h.get(ev) ?? []), cb]); return this }
      private emit(ev: string) { for (const cb of this.h.get(ev) ?? []) cb() }
      end() {}
      exec(_c: string, cb: (e: Error | null, s: unknown) => void) {
        const stream = { on: (ev: string, fn: (d?: Buffer) => void) => { if (ev === 'data') queueMicrotask(() => fn(Buffer.from(''))); if (ev === 'close') queueMicrotask(() => fn()); return stream }, end() {}, stderr: { on: () => {} } }
        cb(null, stream)
      }
      sftp(cb: (e: Error | null, s: unknown) => void) { cb(null, { fastPut: (_l: string, _r: string, d: (e?: Error | null) => void) => d(new Error('EACCES')) }) }
    }
    void Fake
    const tmpd = mkdtempSync(join(tmpdir(), 'pushfail-'))
    writeFileSync(join(tmpd, 'a.png'), 'X')
    await expect(pushTaskFiles(FailingSftpClient as unknown as typeof import('ssh2').Client, plan, 'tp', [{ localPath: join(tmpd, 'a.png'), remoteName: 'a.png' }]))
      .rejects.toThrow('EACCES')
  })
})

describe('error propagation arms', () => {
  it('rejects when sftp subsystem fails', async () => {
    class SftpFailClient {
      private h = new Map<string, Array<(a?: unknown) => void>>()
      connect() { queueMicrotask(() => this.emit('ready')); return this }
      on(ev: string, cb: (a?: unknown) => void) { this.h.set(ev, [...(this.h.get(ev) ?? []), cb]); return this }
      private emit(ev: string) { for (const cb of this.h.get(ev) ?? []) cb() }
      end() {}
      exec(_c: string, cb: (e: Error | null, s: unknown) => void) {
        const stream = { on: (ev: string, fn: (d?: Buffer) => void) => { if (ev === 'data') queueMicrotask(() => fn(Buffer.from(''))); if (ev === 'close') queueMicrotask(() => fn()); return stream }, end() {}, stderr: { on: () => {} } }
        cb(null, stream)
      }
      sftp(cb: (e: Error | null, s: unknown) => void) { cb(new Error('sftp subsystem denied'), null) }
    }
    const tmpd = mkdtempSync(join(tmpdir(), 'sftpfail-'))
    writeFileSync(join(tmpd, 'a'), 'x')
    await expect(pushTaskFiles(SftpFailClient as unknown as typeof import('ssh2').Client, plan, 'ts', [{ localPath: join(tmpd, 'a'), remoteName: 'a' }]))
      .rejects.toThrow('sftp subsystem denied')
  })

  it('du fallback when total line unparseable', async () => {
    const Fake = makeFakeClient({
      [`find ${taskFilesOutDir('td')}`]: 'a.txt',
      [`du -cb '${taskFilesOutDir('td')}/a.txt'`]: 'garbage',
    })
    const got = await collectRunOutputs(Fake, plan, 'td', mkdtempSync(join(tmpdir(), 'du-')), 1024)
    expect(got.map(g => g.filename)).toEqual(['a.txt'])
  })
})

describe('error propagation arms', () => {
  it('propagates fastGet failures out of collectRunOutputs', async () => {
    class GetFailClient {
      private h = new Map<string, Array<(a?: unknown) => void>>()
      connect() { queueMicrotask(() => this.emit('ready')); return this }
      on(ev: string, cb: (a?: unknown) => void) { this.h.set(ev, [...(this.h.get(ev) ?? []), cb]); return this }
      private emit(ev: string) { for (const cb of this.h.get(ev) ?? []) cb() }
      end() {}
      exec(_c: string, cb: (e: Error | null, s: unknown) => void) {
        const stream = { on: (ev: string, fn: (d?: Buffer) => void) => { if (ev === 'data') queueMicrotask(() => fn(Buffer.from('x'))); if (ev === 'close') queueMicrotask(() => fn()); return stream }, end() {}, stderr: { on: () => {} } }
        cb(null, stream)
      }
      sftp(cb: (e: Error | null, s: unknown) => void) { cb(null, { fastGet: (_r: string, _l: string, d: (e?: Error | null) => void) => d(new Error('EIO')) }) }
    }
    await expect(collectRunOutputs(GetFailClient as unknown as typeof import('ssh2').Client, plan, 'tg', mkdtempSync(join(tmpdir(), 'getfail-')), 1024))
      .rejects.toThrow('EIO')
  })

  it('propagates exec failures from cleanup', async () => {
    class ExecFailClient {
      private h = new Map<string, Array<(a?: unknown) => void>>()
      connect() { queueMicrotask(() => this.emit('ready')); return this }
      on(ev: string, cb: (a?: unknown) => void) { this.h.set(ev, [...(this.h.get(ev) ?? []), cb]); return this }
      private emit(ev: string) { for (const cb of this.h.get(ev) ?? []) cb() }
      end() {}
      exec(_c: string, cb: (e: Error | null, s: unknown) => void) { cb(new Error('exec failed'), null) }
    }
    await expect(cleanupTaskFiles(ExecFailClient as unknown as typeof import('ssh2').Client, plan, 'te'))
      .rejects.toThrow('exec failed')
  })
})

describe('connect timeout', () => {
  it('defaults an empty port to 22 while timing out', async () => {
    class RudeClient2 {
      connect(_o: unknown) { return this }
      on() { return this }
      end() { throw new Error('gone') }
    }
    await expect(cleanupTaskFiles(RudeClient2 as unknown as typeof import('ssh2').Client, { env: { host: 'h', port: '', username: 'u' } }, 'tp2', 15))
      .rejects.toThrow('sftp connect timeout')
  })
})

describe('connect error arm', () => {
  it('rejects when the client errors before ready', async () => {
    class ErrClient {
      private h = new Map<string, Array<(a?: unknown) => void>>()
      connect() { queueMicrotask(() => this.emit('error', new Error('ECONNREFUSED'))); return this }
      on(ev: string, cb: (a?: unknown) => void) { this.h.set(ev, [...(this.h.get(ev) ?? []), cb]); return this }
      private emit(ev: string, arg?: unknown) { for (const cb of this.h.get(ev) ?? []) cb(arg) }
      end() {}
    }
    await expect(cleanupTaskFiles(ErrClient as unknown as typeof import('ssh2').Client, plan, 'terr'))
      .rejects.toThrow('ECONNREFUSED')
  })
})

describe('cleanupTaskFiles', () => {
  it('rm -rf the task dir', async () => {
    const Fake = makeFakeClient({})
    await cleanupTaskFiles(Fake, plan, 't5')
    const all = (Fake as unknown as { __instances: Array<{ __cmds: string[] }> }).__instances.flatMap(i => i.__cmds)
    expect(all.some(c => c.includes(`rm -rf ${TASK_FILES_HOME}/t5`))).toBe(true)
  })
})
