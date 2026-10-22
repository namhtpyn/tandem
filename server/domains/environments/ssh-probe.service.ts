import { SECRET_USAGE, type SecretUsage } from '#shared/enums';

import { env } from '../kernel/env';
// SSH probe — Bun-only: Bun.spawn with a hard timeout kill (the app and its
// tests run on Bun; no node fallback). BatchMode ssh with strict options;
// never prompts.

export type ProbeResult = {
  ok: boolean;
  detail: string;
};

function sshArgs(host: string, port: string, username: string, identityFile?: string, askpassDir?: string) {
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
    const argv: string[] = [];
    if (askpassDir) argv.push('env', `SSH_ASKPASS=${askpassDir}/askpass.sh`, 'SSH_ASKPASS_REQUIRE=force', 'DISPLAY=:0');
    argv.push('ssh', ...sshArgs(host, port, username, identityFile, askpassDir));
    return await runSsh(argv, sshTimeoutMs());
  } catch (e) {
    /* v8 ignore next 1 -- runSsh only rejects with Errors; the string fallback is defensive */
    return { ok: false, detail: e instanceof Error ? e.message : 'probe failed' };
  } finally {
    await cleanupIdentity(identityFile);
    await cleanupAskpass(askpassDir);
  }
}

/** 0700 temp dir with an askpass script that prints the b64-embedded secret. */
async function writeAskpass(password: string) {
  const { mkdtemp, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'tandem-askpass-'));
  const script = path.join(dir, 'askpass.sh');
  const encoded = Buffer.from(password, 'utf8').toString('base64');
  await Bun.write(script, `#!/bin/sh\nprintf %s ${encoded} | base64 -d\n`);
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
  const { mkdtemp, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'tandem-ssh-'));
  const file = path.join(dir, 'id');
  await Bun.write(file, ensureTrailingNewline(privateKey));
  await chmod(file, 0o600);
  return file;
}

function ensureTrailingNewline(key: string) {
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

const TIMEOUT_DEFAULT_MS = 10_000;

function sshTimeoutMs() {
  const v = Number.parseInt(env.TANDEM_SSH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_DEFAULT_MS;
}

/** Bun.spawn the ssh argv; a hung child is SIGKILLed at the timeout. */
async function runSsh(argv: string[], timeoutMs: number): Promise<ProbeResult> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
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
