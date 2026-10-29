// ACP-over-SSH transport: open one ssh exec channel whose remote command
// consumes the env blob (secrets NEVER on argv, never on remote disk), then
// execs the employee's ACP executable with the same channel as its stdio.
//
// Byte-count framing: `eval "$(head -c N)"` reads EXACTLY N bytes of stdin as
// the env blob; everything written after those N bytes is the ACP JSON-RPC
// stream for the exec'd agent process.
import { nonNull } from '#shared/utils/non-null';

import type { AcpStream } from './acp.client';
import type { SshPlan } from './ssh-exec.util';

/** remote wrapper: source the blob, then hand the pipe to the ACP server */
export function acpRemoteCommand(envBlobBytes: number, acpExecutable: string) {
  // acpExecutable is router-validated shell-word-safe (letters/digits/_@/.- and spaces)
  return `bash -c 'eval "$(head -c ${envBlobBytes})" && exec ${acpExecutable}'`;
}

/** ssh2-backed AcpStream; exported seam for tests to mock the transport */
export async function openAcpSshStream(
  plan: SshPlan,
  envBlob: string,
  acpExecutable: string,
  _onLine: (line: string) => void,
): Promise<AcpStream> {
  const { loadClient } = await import('./ssh-exec.util');
  const ClientCtor = await loadClient();
  const conn = new ClientCtor();

  let stdoutCb: ((line: string) => void) | null = null;
  let stderrCb: ((line: string) => void) | null = null;
  let closeCb: ((code: number | null) => void) | null = null;
  let stream: { write: (d: Buffer | string) => void; close: () => void; signal: (s: string) => void } | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let ready: (() => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });

  const splitLines = (buf: string, chunk: string, emit: (l: string) => void) => {
    const all = buf + chunk;
    const parts = all.split('\n');
    for (const p of parts.slice(0, -1)) if (p.trim()) emit(p);
    return nonNull(parts[parts.length - 1]); // split always yields a tail element
  };

  conn
    .on('ready', () => {
      conn.exec(
        acpRemoteCommand(Buffer.byteLength(envBlob), acpExecutable),
        (
          err: Error | undefined,
          s: {
            write: (d: Buffer | string) => void;
            close: () => void;
            signal: (s: string) => void;
            on: (ev: 'data' | 'stderr' | 'exit' | 'close', cb: (arg: unknown) => void) => void;
          },
        ) => {
          if (err) {
            nonNull(fail)(new Error(`acp exec error: ${err.message}`));
            try {
              conn.end();
            } catch {
              /* already gone */
            }
            return;
          }
          stream = s;
          s.on('data', (d: unknown) => {
            stdoutBuf = splitLines(stdoutBuf, String(d), (l) => stdoutCb?.(l));
          });
          s.on('stderr', (d: unknown) => {
            stderrBuf = splitLines(stderrBuf, String(d), (l) => stderrCb?.(l));
          });
          s.on('exit', (code: unknown) => closeCb?.(typeof code === 'number' ? code : null));
          s.on('close', () => {
            closeCb?.(null);
          });
          // env blob first (consumed by head -c N), then the channel stays open for
          // JSON-RPC — written synchronously here, so every later write is protocol
          s.write(envBlob);
          nonNull(ready)();
        },
      );
    })
    .on('error', (err: Error) => {
      nonNull(fail)(new Error(`acp ssh error: ${err.message}`));
    })
    .connect({
      host: plan.env.host,
      port: Number(plan.env.port) || 22,
      username: plan.env.username,
      privateKey: plan.sshKey,
      password: plan.sshPassword,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      readyTimeout: 20_000,
    });

  await readyPromise;

  return {
    write: (message: unknown) => {
      stream?.write(`${JSON.stringify(message)}\n`);
    },
    writeRaw: (text: string) => {
      stream?.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    close: () => {
      try {
        stream?.signal('KILL');
      } catch {
        /* not supported / gone */
      }
      try {
        stream?.close();
      } catch {
        /* already gone */
      }
      try {
        conn.end();
      } catch {
        /* already gone */
      }
    },
    onStdoutLine: (cb: (line: string) => void) => {
      stdoutCb = cb;
    },
    onStderrLine: (cb: (line: string) => void) => {
      stderrCb = cb;
    },
    onClose: (cb: (code: number | null) => void) => {
      closeCb = cb;
    },
  };
}
