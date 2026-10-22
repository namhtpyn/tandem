// SSH file shuttle for task attachments — same channel/credentials as the exec seam.
// Paths are RELATIVE (resolve against the SSH user's home on every OS): the task's
// staging tree is ~/.tandem/<taskId>/attachments/ with outputs under out/.
// Push: inputs land in that dir (chowned to the shim's uid on hermes images).
// Collect: everything the agent left in out/ comes back and becomes run outputs.
// Cleanup: the task dir is removed once no run of that task is still running.
// Exported as an object so tests can mock the whole shuttle.
import type { Client } from 'ssh2';

export type SshFilePlan = {
  env: { host: string; port: string; username: string };
  sshKey?: string;
  sshPassword?: string;
};

/** agent-side staging subtree, relative to the environment SSH user's home */
export const TASK_FILES_HOME = '.tandem';

/** ~/.tandem/<taskId>/attachments (relative form works in both exec and sftp) */
export function taskFilesDir(taskId: string) {
  return `${TASK_FILES_HOME}/${taskId}/attachments`;
}

export function taskFilesOutDir(taskId: string) {
  return `${taskFilesDir(taskId)}/out`;
}

/** ALWAYS create ~/.tandem/<taskId>/attachments/out before a turn — even when the
 * task has no input attachments. Without it the dir never exists, agents "write
 * deliverables" into a void (or mangle the path), and collection finds nothing.
 * (incident 7d06bae0, 2026-10-16: 9 screenshots claimed, 0 collected) */
export async function ensureOutDir(
  ClientCtor: typeof Client,
  plan: SshFilePlan,
  taskId: string,
  timeoutMs?: number,
) {
  const conn = await connect(ClientCtor, plan, timeoutMs);
  try {
    const out = taskFilesOutDir(taskId);
    await exec(conn, `mkdir -p ${out}`);
    await exec(
      conn,
      `chown -R 10000:10000 ${TASK_FILES_HOME}/${taskId} 2>/dev/null || chmod -R a+rwX ${TASK_FILES_HOME}/${taskId}`,
    );
  } finally {
    conn.end();
  }
}

function connect(ClientCtor: typeof Client, plan: SshFilePlan, timeoutMs = 20_000): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new ClientCtor();
    const t = setTimeout(() => {
      try {
        conn.end();
      } catch {
        /* not connected */
      }
      reject(new Error('sftp connect timeout'));
    }, timeoutMs);
    conn
      .on('ready', () => {
        clearTimeout(t);
        resolve(conn as unknown as Client);
      })
      .on('error', (e: Error) => {
        clearTimeout(t);
        reject(e);
      })
      .connect({
        host: plan.env.host,
        port: Number(plan.env.port) || 22,
        username: plan.env.username,
        privateKey: plan.sshKey,
        password: plan.sshPassword,
        readyTimeout: 20_000,
      });
  });
}

function sftpOf(conn: Client): Promise<import('ssh2').SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function fastPut(sftp: import('ssh2').SFTPWrapper, local: string, remote: string) {
  return new Promise<void>((resolve, reject) => sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())));
}

function fastGet(sftp: import('ssh2').SFTPWrapper, remote: string, local: string) {
  return new Promise<void>((resolve, reject) => sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve())));
}

function exec(conn: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let out = '';
      stream.on('data', (d: Buffer) => {
        out += d.toString();
      });
      stream.on('close', () => resolve(out.trim()));
      stream.stderr?.on('data', () => {}); // best-effort; errors surface via close
      stream.end();
    });
  });
}

/** push input files to the sandbox: mkdir + scp each + chown to uid 10000 (hermes shim) */
export async function pushTaskFiles(
  ClientCtor: typeof Client,
  plan: SshFilePlan,
  taskId: string,
  files: Array<{ localPath: string; remoteName: string }>,
  timeoutMs?: number,
) {
  if (!files.length) return;
  const conn = await connect(ClientCtor, plan, timeoutMs);
  try {
    const dir = taskFilesDir(taskId);
    await exec(conn, `mkdir -p ${dir}`);
    const sftp = await sftpOf(conn);
    for (const f of files) {
      await fastPut(sftp, f.localPath, `${dir}/${f.remoteName}`);
    }
    // hermes shim drops to uid 10000 — the files must be readable/writable by it
    await exec(
      conn,
      `chown -R 10000:10000 ${TASK_FILES_HOME}/${taskId} 2>/dev/null || chmod -R a+rwX ${TASK_FILES_HOME}/${taskId}`,
    );
  } finally {
    try {
      conn.end();
    } catch {
      /* already gone */
    }
  }
}

export type CollectedFile = { localPath: string; filename: string; size: number };

/** collect files the agent left in out/: returns local copies (caller stores them) */
export async function collectRunOutputs(
  ClientCtor: typeof Client,
  plan: SshFilePlan,
  taskId: string,
  tmpDir: string,
  maxBytes: number,
  timeoutMs?: number,
) {
  const out = [];
  const conn = await connect(ClientCtor, plan, timeoutMs);
  try {
    const outDir = taskFilesOutDir(taskId);
    let names: string[] = [];
    const listing = await exec(conn, `find ${outDir} -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null || true`);
    names = listing ? listing.split('\n').filter(Boolean) : [];
    if (!names.length) return [];
    // size check first — an agent dumping node_modules gets truncated, not stored
    const duRaw = await exec(
      conn,
      `du -cb ${names.map((n) => `'${outDir}/${n.replace(/'/g, "'\\''")}'`).join(' ')} 2>/dev/null | tail -1`,
    );
    const total = Number((duRaw.match(/(\d+)\s+total$/) || [])[1] ?? '0');
    if (total > maxBytes) return [];
    const fs = await import('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    const sftp = await sftpOf(conn);
    for (const name of names) {
      const local = `${tmpDir}/${taskId}-out-${name.replace(/[/\\]/g, '_')}`;
      await fastGet(sftp, `${outDir}/${name}`, local);
      out.push({ localPath: local, filename: name, size: fs.statSync(local).size });
    }
  } finally {
    try {
      conn.end();
    } catch {
      /* already gone */
    }
  }
  return out;
}

/** remove the task's sandbox dir (call only when no run of the task is active) */
export async function cleanupTaskFiles(
  ClientCtor: typeof Client,
  plan: SshFilePlan,
  taskId: string,
  timeoutMs?: number,
) {
  const conn = await connect(ClientCtor, plan, timeoutMs);
  try {
    await exec(conn, `rm -rf ${TASK_FILES_HOME}/${taskId}`);
  } finally {
    try {
      conn.end();
    } catch {
      /* already gone */
    }
  }
}
