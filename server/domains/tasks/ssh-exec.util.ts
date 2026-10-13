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

export async function runOverSsh(plan: SshPlan, command: string, envBlob: string, onLine: OnLine, finish: Finish, resolve: Resolve): Promise<void> {
  const ClientCtor = await loadClient()
  const conn = new ClientCtor()
  conn.on('ready', () => {
    conn.exec(`cat > /tmp/tandem-env.$$ && . /tmp/tandem-env.$$ && rm -f /tmp/tandem-env.$$ && ${command}`, (err, stream) => {
      if (err) {
        conn.end()
        void finish('failed', null)
        resolve({ status: 'failed', exitCode: null })
        return
      }
      stream.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) if (line) onLine(line)
      })
      stream.stderr.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) if (line) onLine(`[stderr] ${line}`)
      })
      stream.on('close', (code: number | null) => {
        conn.end()
        void (async () => {
          await finish(code === 0 ? 'done' : 'failed', code)
          resolve({ status: code === 0 ? 'done' : 'failed', exitCode: code })
        })()
      })
      stream.end(envBlob)
    })
  }).on('error', (err: Error) => {
    void (async () => {
      onLine(`[dispatch] ssh error: ${err.message}`)
      await finish('failed', null)
      resolve({ status: 'failed', exitCode: null })
    })()
  }).connect({
    host: plan.env.host,
    port: Number(plan.env.port) || 22,
    username: plan.env.username,
    privateKey: plan.sshKey,
    password: plan.sshPassword,
  })
}
