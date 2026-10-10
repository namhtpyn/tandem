// SSH probe — Bun Shell first (cross-OS, no shell interpolation); node
// child_process fallback for non-bun runtimes (vitest workers are node).
// BatchMode ssh with strict options; never prompts.

export interface ProbeResult {
  ok: boolean
  detail: string
}

function sshArgs(host: string, port: string, username: string, identityFile?: string): string[] {
  const identity = identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : []
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    ...identity,
    '-p', port,
    `${username}@${host}`,
    'echo', 'tandem-probe-ok',
  ]
}

export async function probeSsh(host: string, port: string, username: string, privateKey?: string): Promise<ProbeResult> {
  const identityFile = await writeIdentity(privateKey)
  try {
    /* v8 ignore start -- bun-runtime-only lines; exercised by `bun run` integration, unreachable under vitest/node */
    const bunModule = 'bun'
    const mod = (await import(/* @vite-ignore */ bunModule)) as typeof import('bun')
    const r = await mod.$`ssh ${sshArgs(host, port, username, identityFile)}`.nothrow().quiet()
    return interpret(r.exitCode, String(r.stdout), String(r.stderr))
    /* v8 ignore stop */
  }
  catch (bunError) {
    // non-bun runtime (vitest/node): 'bun' import fails -> node fallback.
    // bun present but shell threw -> also try node, then surface the error.
    try {
      return await probeViaNode(host, port, username, identityFile)
    }
    catch (nodeError) {
      return { ok: false, detail: pickFailureDetail(bunError, nodeError) }
    }
  }
  finally {
    await cleanupIdentity(identityFile)
  }
}

/** Write an optional private key to a 0600 temp file; undefined when no key. */
async function writeIdentity(privateKey?: string): Promise<string | undefined> {
  if (!privateKey) return undefined
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'tandem-ssh-'))
  const file = path.join(dir, 'id')
  await writeFile(file, ensureTrailingNewline(privateKey), { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith('\n') ? key : `${key}\n`
}

async function cleanupIdentity(file?: string): Promise<void> {
  if (!file) return
  try {
    const { rm } = await import('node:fs/promises')
    const path = await import('node:path')
    await rm(path.dirname(file), { recursive: true, force: true })
  } catch { /* best effort */ }
}

/** when bun itself failed (not just unavailable), its error wins; otherwise
 * the node-path error; plain-string throws degrade to a generic message. */
export function pickFailureDetail(bunError: unknown, nodeError: unknown): string {
  const bunUnavailable = bunError instanceof Error && /Cannot find package|Failed to resolve|ERR_MODULE_NOT_FOUND/.test(bunError.message)
  const cause = bunError instanceof Error && !bunUnavailable
    ? bunError
    : nodeError
  return cause instanceof Error ? cause.message : 'probe failed'
}

const TIMEOUT_DEFAULT_MS = 10_000

function sshTimeoutMs(): number {
  const v = Number.parseInt(process.env.TANDEM_SSH_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_DEFAULT_MS
}

async function probeViaNode(host: string, port: string, username: string, identityFile?: string): Promise<ProbeResult> {
  const { spawn } = await import('node:child_process')
  const child = spawn('ssh', sshArgs(host, port, username, identityFile), { stdio: ['ignore', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), sshTimeoutMs())
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      new Promise<number>(resolve => { child.on('close', code => resolve(code ?? -1)) }),
      new Promise<string>(resolve => { let out = ''; child.stdout!.on('data', d => { out += d }); child.stdout!.on('end', () => resolve(out)) }),
      new Promise<string>(resolve => { let err = ''; child.stderr!.on('data', d => { err += d }); child.stderr!.on('end', () => resolve(err)) }),
    ])
    return interpret(exitCode, stdout, stderr)
  }
  finally {
    clearTimeout(timer)
  }
}

export function interpret(exitCode: number, stdout: string, stderr: string): ProbeResult {
  if (exitCode === 0 && stdout.includes('tandem-probe-ok')) {
    return { ok: true, detail: 'SSH key auth works' }
  }
  const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? `ssh exited ${exitCode}`
  return { ok: false, detail }
}
