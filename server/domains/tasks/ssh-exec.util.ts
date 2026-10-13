// ssh2 execution seam: connect with the plan's credentials, pipe the env
// blob to stdin, run the command, stream stdout/stderr line-by-line.
// Exported separately so tests can mock the ssh2 transport while exercising
// the real stream/finish logic.
import type { Client } from 'ssh2'

export interface SshPlan {
  env: { host: string, port: string, username: string }
  sshKey?: string
  sshPassword?: string
}

type Finish = (status: 'done' | 'failed', exitCode: number | null) => Promise<void>
type Resolve = (v: { status: 'done' | 'failed', exitCode: number | null }) => void
type OnLine = (line: string) => void

/** dynamically imported so tests can vi.mock('ssh2') before first call */
export async function loadClient(): Promise<typeof Client> {
  const { default: { Client: C } } = await import('ssh2')
  return C as unknown as typeof Client
}

// a frozen agent (no TCP reset) must still terminate: cap the whole run.
// Lazy read so tests can shrink it after import.
function runTimeoutMs(): number {
  return Number(process.env.TANDEM_RUN_TIMEOUT_MS ?? 30 * 60_000)
}

export async function runOverSsh(plan: SshPlan, command: string, envBlob: string, onLine: OnLine, finish: Finish, resolve: Resolve): Promise<void> {
  const ClientCtor = await loadClient()
  const conn = new ClientCtor()
  let settled = false
  const settle = (s: 'done' | 'failed', code: number | null, why?: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { conn.end() } catch { /* already gone */ }
    if (why) onLine(why)
    void (async () => {
      await finish(s, code)
      resolve({ status: s, exitCode: code })
    })()
  }
  const timeoutMs = runTimeoutMs()
  const timer = setTimeout(() => settle('failed', null, `[dispatch] run timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
  conn.on('ready', () => {
    conn.exec(`cat > /tmp/tandem-env.$$ && . /tmp/tandem-env.$$ && rm -f /tmp/tandem-env.$$ && ${command}`, (err, stream) => {
      if (err) {
        settle('failed', null, `[dispatch] exec error: ${err.message}`)
        return
      }
      stream.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) if (line) onLine(line)
      })
      stream.stderr.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) if (line) onLine(`[stderr] ${line}`)
      })
      stream.on('close', (code: number | null) => settle(code === 0 ? 'done' : 'failed', code))
      stream.end(envBlob)
    })
  }).on('error', (err: Error) => settle('failed', null, `[dispatch] ssh error: ${err.message}`)).connect({
    host: plan.env.host,
    port: Number(plan.env.port) || 22,
    username: plan.env.username,
    privateKey: plan.sshKey,
    password: plan.sshPassword,
    // hang protection: detect a dead peer instead of waiting on a TCP timeout
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    readyTimeout: 20_000,
  })
}
