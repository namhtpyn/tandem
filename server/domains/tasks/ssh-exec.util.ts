// ssh2 execution seam: connect with the plan's credentials, pipe the env
// blob to stdin, run the command, stream stdout/stderr line-by-line.
// Exported separately so tests can mock the ssh2 transport while exercising
// the real stream/finish logic.
import type { Client } from 'ssh2';

import { RUN_STATUS, type FinishedStatus } from '#shared/enums';

import { sshHostVerifier, type HostKeyTrust } from './ssh-hostkey.util';

export type SshPlan = {
  env: { host: string; port: string; username: string };
  sshKey?: string;
  sshPassword?: string;
} & HostKeyTrust;

type Finish = (status: FinishedStatus, exitCode: number | null) => Promise<void>;
type Resolve = (v: { status: FinishedStatus; exitCode: number | null }) => void;
type OnLine = (line: string) => void;

/** dynamically imported so tests can vi.mock('ssh2') before first call */
export async function loadClient(): Promise<typeof Client> {
  const {
    default: { Client: C },
  } = await import('ssh2');
  return C as unknown as typeof Client;
}

// a frozen agent (no TCP reset) must still terminate: cap the whole run.
async function runTimeoutMs() {
  const { getRunTimeoutMs } = await import('../settings/settings.service');
  return await getRunTimeoutMs();
}

export async function runOverSsh(
  plan: SshPlan,
  command: string,
  envBlob: string,
  onLine: OnLine,
  finish: Finish,
  resolve: Resolve,
) {
  const ClientCtor = await loadClient();
  const conn = new ClientCtor();
  let settled = false;
  const settle = (s: FinishedStatus, code: number | null, why?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      conn.end();
    } catch {
      /* already gone */
    }
    if (why) onLine(why);
    void (async () => {
      await finish(s, code);
      resolve({ status: s, exitCode: code });
    })();
  };
  const timeoutMs = await runTimeoutMs();
  const timer = setTimeout(
    () => settle(RUN_STATUS.FAILED, null, `[dispatch] run timed out after ${Math.round(timeoutMs / 1000)}s`),
    timeoutMs,
  );
  conn
    .on('ready', () => {
      conn.exec(
        `cat > /tmp/tandem-env.$$ && . /tmp/tandem-env.$$ && rm -f /tmp/tandem-env.$$ && ${command}`,
        (err, stream) => {
          if (err) {
            settle(RUN_STATUS.FAILED, null, `[dispatch] exec error: ${err.message}`);
            return;
          }
          stream.on('data', (d: Buffer) => {
            for (const line of d.toString().split('\n')) if (line) onLine(line);
          });
          if (stream.stderr) {
            stream.stderr.on('data', (d: Buffer) => {
              for (const line of d.toString().split('\n')) if (line) onLine(`[stderr] ${line}`);
            });
          }
          stream.on('close', (code: number | null) => settle(code === 0 ? RUN_STATUS.DONE : RUN_STATUS.FAILED, code));
          stream.end(envBlob);
        },
      );
    })
    .on('error', (err: Error) => settle(RUN_STATUS.FAILED, null, `[dispatch] ssh error: ${err.message}`))
    .connect({
      host: plan.env.host,
      port: Number(plan.env.port) || 22,
      username: plan.env.username,
      privateKey: plan.sshKey,
      password: plan.sshPassword,
      // hang protection: detect a dead peer instead of waiting on a TCP timeout
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      readyTimeout: 20_000,
      // host-key law (SPEC: Environments): TOFU verify before auth completes
      hostVerifier: sshHostVerifier(plan),
    });
}
