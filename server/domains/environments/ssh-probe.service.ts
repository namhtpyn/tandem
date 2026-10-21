import { SECRET_USAGE, type SecretUsage } from '#shared/enums';
import { env } from '../kernel/env';
// SSH probe — Bun Shell first (cross-OS, no shell interpolation); node
// child_process fallback for non-bun runtimes (vitest workers are node).
// BatchMode ssh with strict options; never prompts.

export type ProbeResult = {
  ok: boolean;
  detail: string;
};

function sshArgs(host: string, port: string, username: string, identityFile?: string, askpassDir?: string): string[] {
  const identity = identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : [];
  // password mode: BatchMode must be OFF for askpass to run; a fake askpass
  // script echoes $SSHPASSWORD, forced by SSH_ASKPASS_REQUIRE=force
  const askpass = askpassDir
    ? ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no']
    : ['-o', 'BatchMode=yes'];
  return [
    ...askpass,
    '-o',
    'ConnectTimeout=5',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'LogLevel=ERROR',
    ...identity,
    '-p',
    port,
    `${username}@${host}`,
    'echo',
    'tandem-probe-ok',
  ];
}


export async function probeSsh(
  host: string,
  port: string,
  username: string,
  secret?: string,
  usage: SecretUsage = SECRET_USAGE.SSH_KEY,
) {
  const identityFile = usage === SECRET_USAGE.SSH_KEY ? await writeIdentity(secret) : undefined;
  // OpenSSH has no --password flag: SSH_ASKPASS (+ REQUIRE=force, + the DISPLAY
  // sentinel) is the only non-interactive password feed. The askpass script
  // embeds the secret (b64) so no env var carries it; the `env` prefix scopes
  // the vars to the ssh child — the app process env is never touched.
  const askpassDir = usage === SECRET_USAGE.PASSWORD && secret ? await writeAskpass(secret) : undefined;
  try {
    /* v8 ignore start -- bun-runtime-only lines; exercised by `bun run` integration, unreachable under vitest/node */
    const bunModule = 'bun';
    const mod = (await import(/* @vite-ignore */ bunModule)) as typeof import('bun');
    let r;
    if (askpassDir) {
      r = await mod.$`env SSH_ASKPASS=${askpassDir}/askpass.sh SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh ${sshArgs(host, port, username, identityFile, askpassDir)}`.nothrow().quiet();
    } else {
      r = await mod.$`ssh ${sshArgs(host, port, username, identityFile, askpassDir)}`.nothrow().quiet();
    }
    return interpret(r.exitCode, String(r.stdout), String(r.stderr));
    /* v8 ignore stop */
  } catch (bunError) {
    // non-bun runtime (vitest/node): 'bun' import fails -> node fallback.
    // bun present but shell threw -> also try node, then surface the error.
    try {
      return await probeViaNode(host, port, username, identityFile, askpassDir);
    } catch (nodeError) {
      return { ok: false, detail: pickFailureDetail(bunError, nodeError) };
    }
  } finally {
    await cleanupIdentity(identityFile);
    await cleanupAskpass(askpassDir);
  }
}

/** 0700 temp dir with an askpass script that prints the b64-embedded secret. */
async function writeAskpass(password: string) {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'tandem-askpass-'));
  const script = path.join(dir, 'askpass.sh');
  const encoded = Buffer.from(password, 'utf8').toString('base64');
  await writeFile(script, `#!/bin/sh\nprintf %s ${encoded} | base64 -d\n`, { mode: 0o700 });
  await chmod(script, 0o700);
  return dir;
}

async function cleanupAskpass(dir?: string) {
  if (!dir) return;
  try {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Write an optional private key to a 0600 temp file; undefined when no key. */
async function writeIdentity(privateKey?: string) {
  if (!privateKey) return undefined;
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'tandem-ssh-'));
  const file = path.join(dir, 'id');
  await writeFile(file, ensureTrailingNewline(privateKey), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith('\n') ? key : `${key}\n`;
}

async function cleanupIdentity(file?: string) {
  if (!file) return;
  try {
    const { rm } = await import('node:fs/promises');
    const path = await import('node:path');
    await rm(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** when bun itself failed (not just unavailable), its error wins; otherwise
 * the node-path error; plain-string throws degrade to a generic message. */
export function pickFailureDetail(bunError: unknown, nodeError: unknown): string {
  const bunUnavailable =
    bunError instanceof Error && /Cannot find package|Failed to resolve|ERR_MODULE_NOT_FOUND/.test(bunError.message);
  const cause = bunError instanceof Error && !bunUnavailable ? bunError : nodeError;
  return cause instanceof Error ? cause.message : 'probe failed';
}

const TIMEOUT_DEFAULT_MS = 10_000;

function sshTimeoutMs(): number {
  const v = Number.parseInt(env.TANDEM_SSH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_DEFAULT_MS;
}

async function probeViaNode(host: string, port: string, username: string, identityFile?: string, askpassDir?: string) {
  const { spawn } = await import('node:child_process');
  // `env` prefix scopes the askpass vars to the child; the rest inherits
  const argv: string[] = [];
  if (askpassDir) argv.push('env', `SSH_ASKPASS=${askpassDir}/askpass.sh`, 'SSH_ASKPASS_REQUIRE=force', 'DISPLAY=:0');
  argv.push('ssh', ...sshArgs(host, port, username, identityFile, askpassDir));
  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), sshTimeoutMs());
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? -1));
      }),
      new Promise<string>((resolve) => {
        let out = '';
        child.stdout!.on('data', (d) => {
          out += d;
        });
        child.stdout!.on('end', () => resolve(out));
      }),
      new Promise<string>((resolve) => {
        let err = '';
        child.stderr!.on('data', (d) => {
          err += d;
        });
        child.stderr!.on('end', () => resolve(err));
      }),
    ]);
    return interpret(exitCode, stdout, stderr);
  } finally {
    clearTimeout(timer);
  }
}

export function interpret(exitCode: number, stdout: string, stderr: string): ProbeResult {
  if (exitCode === 0 && stdout.includes('tandem-probe-ok')) {
    return { ok: true, detail: 'SSH key auth works' };
  }
  const detail = stderr.trim().split('\n').filter(Boolean).pop() ?? `ssh exited ${exitCode}`;
  return { ok: false, detail };
}
