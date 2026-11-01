// STEER-HOOK LIFECYCLE (#161): the per-run steer hook registered on session open
// is transient — executeRun's finally is the single delete point every settle path
// passes exactly once. The old code deleted only on a FAILED steer, so every
// settled run pinned its ACP client context (connection + bridged streams)
// forever: silent unbounded RSS growth on a long-lived server. Both tests drive
// the REAL runAcpTurn against a scripted in-memory AcpStream (acp.test's fake),
// so the hook registration itself rides the real session-open path.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpStream } from '../../server/domains/tasks/acp.client';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  runRow: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  midRunSteerIds: [] as string[][],
  workflow: [] as string[],
  stream: null as AcpStream | null,
}));

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: new Proxy(
      {},
      {
        get: (_t, table: string) => ({
          findMany: async () => h.tables[table] ?? [],
          findFirst: async () => h.runRow,
        }),
      },
    ),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          h.updates.push(v);
          // awaitable AND .returning()-able (the bounce's atomic re-check reads it)
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: 'kept' }] });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          // lastSessionFor (resume lookup) + the settle sweep's sibling scan
          where: () => ({ orderBy: () => ({ limit: async () => [{ sessionId: null }] }) }),
        }),
      }),
    }),
  },
}));

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/settings/settings.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/settings/settings.service')>();
  return { ...mod, getRunTimeoutMs: async () => 5_000 };
});

vi.mock('../../server/domains/tasks/brief.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/brief.service')>();
  return { ...mod, loadBriefData: async () => ({ attachments: [] }) };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    updateRunMessageBody: async () => {},
    appendMessageAttachments: async () => {},
    createRunMessage: async () => ({ id: 'm1' }),
  };
});

vi.mock('../../server/domains/tasks/workflow.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/workflow.service')>();
  return {
    ...mod,
    submitResult: async (...args: unknown[]) => void h.workflow.push(['submit', args]),
    askQuestion: async (...args: unknown[]) => void h.workflow.push(['ask', args]),
  };
});

vi.mock('../../server/domains/tasks/ssh-files.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/ssh-files.util')>();
  return {
    ...mod,
    collectRunOutputs: async () => [],
    cleanupTaskFiles: async () => {},
    ensureOutDir: async () => {},
  };
});

vi.mock('../../server/domains/tasks/ssh-exec.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/ssh-exec.util')>();
  return { ...mod, loadClient: async () => class {} };
});

vi.mock('../../server/domains/tasks/acp-ssh.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/acp-ssh.util')>();
  return { ...mod, openAcpSshStream: async () => h.stream };
});

import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

import { executeRun, liveSteerRunIds } from '../../server/domains/tasks/runner.service';

/** scripted in-memory AcpStream (pared from acp.test's FakeAcp — vi.mock is per-file) */
type AgentScript = (msg: Record<string, unknown>, send: (o: unknown) => void) => void;
class FakeAcp implements AcpStream {
  private stdoutCb: ((l: string) => void) | null = null;
  private preLines: string[] = [];
  constructor(private script: AgentScript) {}
  writeRaw(text: string) {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    for (const l of line.split('\n')) {
      if (!l.trim()) continue;
      try {
        this.script(JSON.parse(l) as Record<string, unknown>, (o) => this.send(o));
      } catch {
        /* agent script error = agent silence */
      }
    }
  }
  write(m: unknown) {
    this.writeRaw(`${JSON.stringify(m)}\n`);
  }
  send(o: unknown) {
    const line = `${JSON.stringify(o)}\n`;
    if (this.stdoutCb) this.stdoutCb(line);
    else this.preLines.push(line);
  }
  onStdoutLine(cb: (l: string) => void) {
    this.stdoutCb = cb;
    for (const l of this.preLines.splice(0)) cb(l);
  }
  onStderrLine() {}
  private closeCb: ((c: number | null) => void) | null = null;
  private closed = false;
  onClose(cb: (c: number | null) => void) {
    this.closeCb = cb;
  }
  close() {
    if (this.closed) return; // teardown re-closes; a re-fire would recurse
    this.closed = true;
    this.closeCb?.(null); // runAcpTurn's dead-promise + teardown ride this
  }
}

/** protocol answers shared by both scripts; the prompt turn is the script's own */
const agent = (onPrompt: (msg: Record<string, unknown>, send: (o: unknown) => void) => void) =>
  new FakeAcp((msg, send) => {
    const method = msg.method as string | undefined;
    if (!method) return;
    if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    else if (method === 'session/prompt') onPrompt(msg, send);
  });
const seedDb = () => {
  h.tables = {
    tasks: [{ id: 't1', title: 'T', description: 'd', assigneeId: 'ai-1', status: STATUS.doing, failStreak: 0 }],
    aiEmployees: [
      {
        userId: 'ai-1',
        environmentId: 'env-1',
        executable: 'hermes acp',
        providerId: null,
        model: null,
        apiKeySecretId: null,
      },
    ],
    environments: [
      {
        id: 'env-1',
        name: 'default',
        host: 'agent-host',
        port: '22',
        username: 'agent',
        secretId: null,
        secretUsage: null,
        hostKeyFingerprint: null,
      },
    ],
    user: [{ name: 'Fixer' }],
  };
  h.runRow = {
    id: 'r1',
    status: RUN_STATUS.RUNNING,
    attempts: 4,
    output: '',
    prompt: 'the frozen brief',
    message: { taskId: 't1' },
  };
};

const runAttempt = { attempt: 4, maxAttempts: 4 };

beforeEach(() => {
  h.updates = [];
  h.midRunSteerIds = [];
  h.workflow = [];
  h.stream = null;
  seedDb();
});

describe('STEER-HOOK LIFECYCLE (#161): a settled run retains no steer hook', () => {
  it('SUCCESS settle: hook is live mid-turn, gone once executeRun resolves', async () => {
    h.stream = agent((msg, send) => {
      // runs when the session/prompt request arrives — the hook must be registered
      h.midRunSteerIds.push(liveSteerRunIds());
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '{"kind": "result", "body": "done"}' },
          },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const res = await executeRun('r1', 'http://127.0.0.1:3000', runAttempt);
    expect(res.status).toBe(RUN_STATUS.DONE);
    expect(h.midRunSteerIds).toHaveLength(1);
    expect(h.midRunSteerIds[0]).toEqual(['r1']); // hook live while the turn runs
    expect(liveSteerRunIds()).toEqual([]); // and gone the moment the run settles
  });

  it('FAILED settle (agent error frame): still gone — the failure path cleans up too', async () => {
    h.stream = agent((msg, send) => {
      h.midRunSteerIds.push(liveSteerRunIds());
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'agent exploded' } });
    });
    const res = await executeRun('r1', 'http://127.0.0.1:3000', runAttempt);
    expect(res.status).toBe(RUN_STATUS.FAILED);
    expect(h.midRunSteerIds[0]).toEqual(['r1']);
    expect(liveSteerRunIds()).toEqual([]);
    // terminal settle actually happened (row settled FAILED, not left RUNNING)
    expect(h.updates.some((u) => u.status === RUN_STATUS.FAILED)).toBe(true);
  });
});
