// ACP client (v1 subset) + ACP-over-SSH transport against in-memory fakes.
// The fake agent is a programmable AcpStream; the ssh mock is a pared-down
// version of dispatcher.test's (both re-implemented because vi.mock is per-file).
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { env, setEnv } from '#server/domains/kernel/env';
import type { AcpStream } from '#server/domains/tasks/acp.client';
import { OBLIGATION_STATUS, RUN_STATUS } from '#shared/enums';

const NL_SRC = String.fromCharCode(10); // a real newline byte on the wire

/** the connect is async — poll for the NEWLY constructed client instead of a fixed
 * sleep (a fixed 10ms raced under CI load: FakeClient.last was still undefined, and
 * a stale .last from the previous test would ready the WRONG connection). */
type FakeSshClient = {
  stream: {
    blob: string;
    writes: string[];
    emitStdout(t: string): void;
    emitStderr(t: string): void;
    emitExit(c: unknown): void;
    close(): void;
    signal(s: string): void;
  };
  emitReady(): void;
  emitError(e: Error): void;
  execError: Error | null;
  ended: boolean;
};

let lastReturnedClient: FakeSshClient | null = null;
async function lastClient() {
  // the vi.mock'd ssh2 module exposes the fake's statics, not the real Client type
  const {
    default: { Client },
  } = await import('ssh2');
  const FakeClient = Client as unknown as {
    last?: FakeSshClient;
    constructed: number;
    until: (n: number) => Promise<void>;
  };
  // DEFFERED, not polled: `until` resolves the moment the fake constructs the next
  // client (the old 400×25ms loop sat on the clock for up to 10s on a failure)
  const seen = FakeClient.constructed;
  const candidate = FakeClient.last;
  if (!candidate || candidate === lastReturnedClient) await FakeClient.until(seen);
  const next = FakeClient.last;
  if (!next || next === lastReturnedClient) throw new Error('no ssh2 fake client was constructed');
  lastReturnedClient = next;
  return next;
}

vi.mock('ssh2', () => {
  class FakeStream {
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    writes: string[] = [];
    blob = '';
    jsonStarted = false;
    blobExpected: number | null = null;
    agent: ((msg: Record<string, unknown>) => void) | null = null;
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      return this;
    }
    write(d: unknown) {
      const s = String(d);
      this.writes.push(s);
      if (!this.jsonStarted) {
        if (this.blobExpected === null) this.blobExpected = FakeClient.blobLen ?? s.length;
        this.blob += s;
        if (this.blob.length >= this.blobExpected) {
          const rest = this.blob.slice(this.blobExpected);
          this.blob = this.blob.slice(0, this.blobExpected);
          this.jsonStarted = true;
          if (rest.trim()) this.feed(rest);
        }
        return;
      }
      this.feed(s);
    }
    signal(_s: string) {
      (this.handlers['signal'] ?? []).forEach((f) => {
        (f as (x: unknown) => void)(null);
      });
    }
    close() {
      (this.handlers['close'] ?? []).forEach((f) => {
        (f as (c: unknown) => void)(null);
      });
    }
    emitStdout(t: string) {
      (this.handlers['data'] ?? []).forEach((f) => {
        (f as (b: Buffer) => void)(Buffer.from(t));
      });
    }
    emitStderr(t: string) {
      (this.handlers['stderr'] ?? []).forEach((f) => {
        (f as (b: Buffer) => void)(Buffer.from(t));
      });
    }
    emitExit(c: number | null) {
      (this.handlers['exit'] ?? []).forEach((f) => {
        (f as (c: unknown) => void)(c);
      });
    }
    send(obj: unknown) {
      this.emitStdout(`${JSON.stringify(obj)}\n`);
    }
    feed(s: string) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.agent?.(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* non-JSON */
        }
      }
    }
  }
  class FakeClient {
    static constructed = 0;
    static waiters: Array<() => void> = [];
    static async until(n: number) {
      while (FakeClient.constructed <= n) await new Promise<void>((res) => FakeClient.waiters.push(res));
    }
    static last: FakeClient;
    static blobLen: number | null = null;
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    execError: Error | null = null;
    stream = new FakeStream();
    ended = false;
    constructor() {
      FakeClient.last = this;
      FakeClient.constructed += 1;
      const wake = FakeClient.waiters;
      FakeClient.waiters = [];
      for (const res of wake) res();
    }
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      return this;
    }
    end() {
      this.ended = true;
    }
    exec(cmd: string, cb: (e: Error | null, s: unknown) => void) {
      const m = /head -c (\d+)/.exec(String(cmd));
      FakeClient.blobLen = m ? Number(m[1]) : null;
      this.stream.blobExpected = FakeClient.blobLen;
      cb(this.execError, this.execError ? null : this.stream);
    }
    connect(o: unknown) {
      (this as unknown as { connectOpts: unknown }).connectOpts = o; // host-key law wiring (#129)
      /* tests drive ready/error manually */
    }
    emitReady() {
      (this.handlers['ready'] ?? []).forEach((f) => {
        (f as () => void)();
      });
    }
    emitError(e: Error) {
      (this.handlers['error'] ?? []).forEach((f) => {
        (f as (x: Error) => void)(e);
      });
    }
  }
  return { default: { Client: FakeClient } };
});

/** in-memory AcpStream wired to a scripted agent */
type AgentScript = (msg: Record<string, unknown>, send: (o: unknown) => void, stream: FakeAcp) => void;
class FakeAcp implements AcpStream {
  stdoutCb: ((l: string) => void) | null = null;
  writeRaw(t: string) {
    this.write(t);
  }
  stderrCb: ((l: string) => void) | null = null;
  closeCb: ((c: number | null) => void) | null = null;
  closed = false;
  written: string[] = [];
  preLines: string[] = []; // bytes that arrived before the consumer attached
  constructor(private script: AgentScript) {}
  onStdoutLine(cb: (l: string) => void) {
    this.stdoutCb = cb;
    const queued = this.preLines;
    this.preLines = [];
    for (const l of queued) cb(l);
  }
  onStderrLine(cb: (l: string) => void) {
    this.stderrCb = cb;
  }
  onClose(cb: (c: number | null) => void) {
    this.closeCb = cb;
  }
  write(m: unknown) {
    this.writeRaw(`${JSON.stringify(m)}\n`);
  }
  writeRaw(text: string) {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    this.written.push(line);
    for (const l of line.split('\n')) {
      if (!l.trim()) continue;
      try {
        this.script(JSON.parse(l) as Record<string, unknown>, (o) => this.send(o), this);
      } catch {
        /* agent script error = agent silence */
      }
    }
  }
  send(o: unknown) {
    const line = `${JSON.stringify(o)}\n`;
    if (this.stdoutCb) this.stdoutCb(line);
    else this.preLines.push(line); // agent answered before runAcpTurn registered
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(null);
  }
}

function fakeAgent(script: AgentScript) {
  return new FakeAcp(script);
}

/** the standard happy agent: answers protocol, streams two chunks, end_turn */
function happyAgent(final: Record<string, unknown> = { stopReason: 'end_turn' }) {
  return fakeAgent((msg, send) => {
    const method = msg.method as string | undefined;
    if (!method) return;
    if (method === 'initialize')
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      });
    else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    else if (method === 'session/resume') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-r' } });
    else if (method === 'session/prompt') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working…' } },
        },
      });
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
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            toolCallId: 't1',
            title: 'read_file',
            status: 'in_progress',
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used: 10, size: 100 } },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: final });
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

type TurnOpts = {
  resumeSessionId?: string | null;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  /** #229: the hook hands over the mid-turn steer AND the user-issued stop */
  onSessionOpen?: (hooks: { steer: (text: string) => Promise<boolean>; stop: () => void }) => void;
  /** #270 MCP dispatch injection */
  mcpServers?: import('@agentclientprotocol/sdk').McpServer[];
};
const turn = (stream: AcpStream, extra: TurnOpts = {}) =>
  import('#server/domains/tasks/acp.client').then(({ runAcpTurn }) =>
    runAcpTurn({ stream, prompt: 'do the thing', timeoutMs: 2_000, ...extra }),
  );

describe('acp.client turns', () => {
  it('happy path: initialize → session/new → chunks → end_turn; transcript concatenated', async () => {
    const lines: string[] = [];
    const stream = happyAgent();
    const res = await turn(stream, { onLine: (l) => lines.push(l) });
    expect(res.sessionId).toBe('sess-1');
    expect(res.stopReason).toBe('end_turn');
    expect(res.transcript).toBe('working…{"kind": "result", "body": "done"}');
    expect(lines).toContain('working…{"kind": "result", "body": "done"}'); // no newline between chunks = one line, flushed at turn end
    expect(lines).toContain('[tool] read_file in_progress');
    expect(lines).toContain('[context] 10/100 tokens');
    // stream torn down after the turn
    expect(stream.closed).toBe(true);
  });

  // #270 MCP DISPATCH INJECTION: the caller's mcpServers ride session/new AND
  // session/resume verbatim; the default stays the spec-shape empty list.
  it('mcpServers ride session/new and session/resume payloads verbatim; default = empty list', async () => {
    const servers = [
      {
        type: 'http' as const,
        name: 'ctx7',
        url: 'https://mcp.example/v1',
        headers: [{ name: 'Authorization', value: 'Bearer sk-cred' }],
      },
    ];
    const fresh = happyAgent();
    await turn(fresh, { mcpServers: servers });
    const newMsg = JSON.parse(fresh.written.find((l) => l.includes('"session/new"'))!) as {
      params: { mcpServers: unknown[] };
    };
    expect(newMsg.params.mcpServers).toEqual(servers);

    const resumed = happyAgent();
    await turn(resumed, { resumeSessionId: 'sess-old', mcpServers: servers });
    const resumeMsg = JSON.parse(resumed.written.find((l) => l.includes('"session/resume"'))!) as {
      params: { mcpServers: unknown[] };
    };
    expect(resumeMsg.params.mcpServers).toEqual(servers);

    const bare = happyAgent();
    await turn(bare);
    const bareMsg = JSON.parse(bare.written.find((l) => l.includes('"session/new"'))!) as {
      params: { mcpServers: unknown[] };
    };
    expect(bareMsg.params.mcpServers).toEqual([]);
  });

  it('onSessionOpen exposes a mid-turn steer (second session/prompt); agent error => false', async () => {
    let steer: ((text: string) => Promise<boolean>) | undefined;
    let promptsSeen = 0;
    let firstPromptId: number | undefined;
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-st' } });
      else if (method === 'session/prompt') {
        promptsSeen += 1;
        if (promptsSeen === 1) {
          // hold the MAIN turn open until the steer prompts have been exercised
          firstPromptId = msg.id as number;
        } else if (promptsSeen === 2) {
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'busy' } });
        }
      }
    });
    const turnP = turn(stream, {
      onSessionOpen: ({ steer: s }) => {
        steer = s;
      },
    });
    // mid-turn: the steer fires while the main prompt is still open
    for (let i = 0; i < 200 && promptsSeen < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(steer).toBeTruthy();
    await expect(steer!('pivot: use sqlite')).resolves.toBe(true);
    await expect(steer!('again')).resolves.toBe(false);
    // release the main prompt — the turn completes
    stream.send({ jsonrpc: '2.0', id: firstPromptId, result: { stopReason: 'end_turn' } });
    await turnP;
  });

  // #229 STOP-RUN: the session-open hook also hands over a stop() — session/cancel
  // for the open session, then the cancel grace kills the stream when the turn has
  // not settled (a user-issued stop, not the timeout path).
  it('stop() notifies session/cancel for the open session; the grace kills the unsettled stream', async () => {
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '40' });
    try {
      let hooks: { steer?: unknown; stop?: () => void } = {};
      const stream = fakeAgent((msg, send) => {
        const method = msg.method as string | undefined;
        if (!method) return;
        if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-stop' } });
        // session/prompt intentionally NEVER answered — the turn is held open
      });
      const turnP = turn(stream, {
        onSessionOpen: (h) => {
          hooks = h;
        },
      });
      turnP.catch(() => {}); // handler rides from creation — the rejection must never go unhandled
      for (let i = 0; i < 400 && !hooks.stop; i++) await new Promise((r) => setTimeout(r, 5));
      expect(hooks.stop).toBeTruthy();
      hooks.stop!();
      // the cancel notify is immediate and names the OPEN session
      let cancelLine = '';
      for (let i = 0; i < 100 && !cancelLine; i++) {
        await new Promise((r) => setTimeout(r, 2));
        cancelLine = stream.written.find((l) => l.includes('"session/cancel"')) ?? '';
      }
      expect(JSON.parse(cancelLine).params).toEqual({ sessionId: 'sess-stop' });
      // the grace holds the wire open briefly — a settling agent can still land its answer
      expect(stream.closed).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      // grace elapsed, turn unsettled → teardown
      expect(stream.closed).toBe(true);
      await expect(turnP).rejects.toThrow();
    } finally {
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  });

  it('a stop after the turn settled is inert — the grace never re-tears-down a finished stream', async () => {
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '30' });
    try {
      let hooks: { steer?: unknown; stop?: () => void } = {};
      const stream = happyAgent();
      const res = await turn(stream, {
        onSessionOpen: (h) => {
          hooks = h;
        },
      });
      expect(res.stopReason).toBe('end_turn');
      expect(stream.closed).toBe(true); // the settle path already tore the stream down
      let extraCloses = 0;
      const origClose = stream.close.bind(stream);
      stream.close = () => {
        extraCloses += 1;
        origClose();
      };
      expect(() => hooks.stop!()).not.toThrow();
      await new Promise((r) => setTimeout(r, 90)); // past the grace
      expect(extraCloses).toBe(0); // a settled turn is never re-torn-down by its stop
    } finally {
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  });

  // #262: a stop fired at a DEAD wire (transport blip between the turn's start
  // and the stop) must not escape a rejection — an unhandled one terminates the
  // whole bun server. The fake's writeRaw throws post-close the way a dead ssh2
  // channel does, so the cancel notify's write genuinely fails.
  it('a stop on a dead wire (writeRaw throws post-close) never escapes a rejection', async () => {
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '20' });
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      let hooks: { steer?: unknown; stop?: () => void } = {};
      const stream = fakeAgent((msg, send) => {
        const method = msg.method as string | undefined;
        if (!method) return;
        if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-dead' } });
        // session/prompt intentionally NEVER answered
      });
      const turnP = turn(stream, {
        onSessionOpen: (h) => {
          hooks = h;
        },
      });
      turnP.catch(() => {});
      for (let i = 0; i < 400 && !hooks.stop; i++) await new Promise((r) => setTimeout(r, 5));
      expect(hooks.stop).toBeTruthy();
      // the wire dies on the WRITE side first (channel gone, close not yet
      // propagated — the exact Stop-during-a-transport-blip window): every write
      // throws like a dead ssh2 channel
      let deadWrites = 0;
      const origWriteRaw = stream.writeRaw.bind(stream);
      stream.writeRaw = (t: string) => {
        deadWrites += 1;
        origWriteRaw(t);
        throw new Error('write EPIPE: channel gone');
      };
      await new Promise((r) => setTimeout(r, 5)); // any queued writes land first
      expect(() => hooks.stop!()).not.toThrow(); // cancel notify rides the dead wire
      stream.close(); // THEN the close propagates: the dead-wire race rejects the prompt
      await new Promise((r) => setTimeout(r, 80)); // grace + notify write queue settle
      await expect(turnP).rejects.toThrow('acp stream closed');
      await new Promise((r) => setTimeout(r, 20)); // one macrotask for any escapee
      expect(unhandled).toEqual([]); // NO rejection escaped — the process survives
      expect(deadWrites).toBeGreaterThan(0); // the throwing path was genuinely exercised
    } finally {
      process.off('unhandledRejection', onUnhandled);
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  });

  it('notifications never split a half-streamed envelope line (queued behind chunks)', async () => {
    const lines: string[] = [];
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-q' } });
      else if (method === 'session/prompt') {
        // chunk 1: envelope WITHOUT trailing newline, then a usage notification lands
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '{"kind": "result", "body": "half' },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 18506, size: 1000000 } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' half"}' } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    await turn(stream, { onLine: (l) => lines.push(l) });
    // the envelope line stays whole; the notification rides AFTER it, never inside
    expect(lines.some((l) => l === '{"kind": "result", "body": "half half"}')).toBe(true);
    expect(lines.filter((l) => l === '[context] 18506/1000000 tokens')).toHaveLength(1);
    expect(lines.indexOf('[context] 18506/1000000 tokens')).toBeGreaterThan(
      lines.indexOf('{"kind": "result", "body": "half half"}'),
    );
  });

  it('outputSchema: contract appended to the prompt; structured parsed from the transcript', async () => {
    const { z } = await import('zod');
    const Report = z.object({ score: z.number(), notes: z.string() });
    let sawPrompt = '';
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-s' } });
      else if (method === 'session/prompt') {
        sawPrompt = JSON.stringify((msg.params as { prompt?: unknown } | undefined)?.prompt ?? '');
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'analysis\n' } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '{"score": 8, "notes": "solid"}' },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    const res = await turn(stream, {});
    // plain turn: no structured field
    expect((res as Record<string, unknown>).structured).toBeUndefined();
    void sawPrompt;
    const stream2 = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-s2' } });
      else if (method === 'session/prompt') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'analysis\n{"score": 8, "notes": "solid"}' },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    const { runAcpTurn } = await import('#server/domains/tasks/acp.client');
    const res2 = await runAcpTurn({ stream: stream2, prompt: 'grade it', timeoutMs: 2_000, outputSchema: Report });
    expect(res2.structured).toEqual({ score: 8, notes: 'solid' });
    // the contract rode along on the prompt
    const stream3 = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-s3' } });
      else if (method === 'session/prompt') {
        const p = (msg.params as { prompt?: unknown } | undefined)?.prompt;
        sawPrompt = typeof p === 'string' ? p : JSON.stringify(p ?? '');
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    await runAcpTurn({ stream: stream3, prompt: 'grade it', timeoutMs: 2_000, outputSchema: Report });
    expect(sawPrompt).toContain('grade it');
    expect(sawPrompt).toContain('OUTPUT CONTRACT');
  });

  it('resume: an existing session id skips session/new', async () => {
    const stream = happyAgent();
    const res = await turn(stream, { resumeSessionId: 'sess-r' });
    expect(res.sessionId).toBe('sess-r');
    expect(stream.written.join('')).not.toContain('"session/new"');
  });

  it('resume failure falls back to a fresh session', async () => {
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/resume')
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'no such session' } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fresh' } });
      else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const lines: string[] = [];
    const res = await turn(stream, { resumeSessionId: 'gone', onLine: (l) => lines.push(l) });
    expect(res.sessionId).toBe('sess-fresh');
    expect(lines.some((l) => l.includes('starting a new session'))).toBe(true);
  });

  it('permission requests are auto-allowed and logged; unknown agent calls get -32601', async () => {
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') {
        send({
          jsonrpc: '2.0',
          id: 999,
          method: 'session/request_permission',
          params: {
            sessionId: 's',
            toolCall: { toolCallId: 't0' },
            options: [{ optionId: 'o1', name: 'run terminal', kind: 'allow_once' }],
          },
        });
        send({ jsonrpc: '2.0', id: 998, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      } else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const lines: string[] = [];
    await turn(stream, { onLine: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes('allowed: run terminal'))).toBe(true);
    // the client's own writes contain the SELECTED allow option and the
    // method-not-found error for agent calls we never advertised
    const wrote = stream.written.join('');
    expect(wrote).toContain('"optionId":"o1"');
    expect(wrote).toContain('-32601');
  });

  it('agent-initiated session/cancel notification is surfaced, stderr prefixed', async () => {
    const stream = fakeAgent((msg, send, s) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') {
        s.stderrCb?.('adapter log line');
        send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt')
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: OBLIGATION_STATUS.CANCELLED } });
    });
    const lines: string[] = [];
    const res = await turn(stream, { onLine: (l) => lines.push(l) });
    expect(lines.some((l) => l === '[acp] adapter log line')).toBe(true);
    // v1 SDK: an agent-initiated session/cancel notification is logged-and-dropped
    // (never routed to the client) — the turn still ends by the prompt response
    expect(lines.some((l) => l.includes('agent cancelled the turn'))).toBe(false);
    expect(res.stopReason).toBe(OBLIGATION_STATUS.CANCELLED);
  });

  it('non-JSON stdout lines are logged, never crash the turn', async () => {
    const stream = fakeAgent((msg, send, s) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') {
        s.stdoutCb?.('this is not json\n');
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const lines: string[] = [];
    const res = await turn(stream, { onLine: (l) => lines.push(l) });
    // v1 SDK: unparseable stdout lines are swallowed by the framing layer (never
    // crash, never log) — the turn completes regardless
    expect(lines.some((l) => l.includes('non-JSON stdout'))).toBe(false);
    expect(res.stopReason).toBe('end_turn');
  });

  it('initialize error rejects; session/new error rejects; prompt error rejects with transcript', async () => {
    const mk = (breakAt: 'initialize' | 'session/new' | 'session/prompt') =>
      fakeAgent((msg, send) => {
        const method = msg.method as string | undefined;
        if (!method) return;
        if (method === breakAt) {
          if (breakAt === 'session/prompt')
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 's',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial work' } },
              },
            });
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `${breakAt} boom` } });
          return;
        }
        if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        else if (method === 'session/prompt') {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial work' } },
            },
          });
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'prompt boom' } });
        }
      });
    await expect(turn(mk('initialize'))).rejects.toThrow('initialize boom');
    await expect(turn(mk('session/new'))).rejects.toThrow('session/new boom');
    await expect(turn(mk('session/prompt'))).rejects.toThrow(/prompt boom.*partial work/);
  });

  it('timeout: session/cancel sent, grace kills the stream, prompt rejects', async () => {
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '40' });
    try {
      const stream = fakeAgent((msg, send) => {
        const method = msg.method as string | undefined;
        if (!method) return;
        if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        // session/prompt intentionally NEVER answered
      });
      const lines: string[] = [];
      await expect(turn(stream, { timeoutMs: 30, onLine: (l) => lines.push(l) })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 80));
      expect(stream.written.join('')).toContain('session/cancel');
      expect(stream.closed).toBe(true);
      expect(lines.some((l) => l.includes('timed out'))).toBe(true);
    } finally {
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  }, 10_000);

  it('stream dying mid-prompt unblocks the pending turn', async () => {
    const stream = fakeAgent((msg, send, s) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        setTimeout(() => s.close(), 10); // dies while session/prompt is pending
      }
    });
    await expect(turn(stream)).rejects.toThrow();
  });

  it('odd-shape protocol traffic never breaks the turn', async () => {
    // the SDK validates both directions now: an invalid session/update payload or an
    // invalid permission request is rejected WITHOUT killing the turn
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
        });
        // malformed permission request (legacy id-only option, no toolCall): the SDK
        // rejects it on the wire — our auto-allow handler never sees it
        send({
          jsonrpc: '2.0',
          id: 42,
          method: 'session/request_permission',
          params: { sessionId: 's', options: [{ id: 'op-raw' }] },
        });
      } else if (method === 'session/resume') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } }); // no update payload — dropped by the SDK, connection survives
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: '' } }); // empty echo falls back to the requested id in our layer
      } else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const lines: string[] = [];
    const res = await turn(stream, { resumeSessionId: 'keep-me', onLine: (l) => lines.push(l) });
    expect(res.sessionId).toBe('keep-me'); // empty echo keeps the requested id
    // the malformed permission request never reached our handler
    expect(lines.some((l) => l.includes('allowed: op-raw'))).toBe(false);
  });

  it('a JSON-RPC prompt error cancels the gateway-resident turn before failing', async () => {
    let promptsSeen = 0;
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-err' } });
      else if (method === 'session/prompt') {
        promptsSeen += 1;
        // the agent's handler raised: generic -32603, turn keeps running server-side
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
      }
    });
    await expect(turn(stream)).rejects.toThrow('Internal error');
    // the client told the agent to stop the (still live) turn
    const cancels = stream.written.filter((l) => l.includes('"session/cancel"'));
    expect(cancels.length).toBe(1);
    expect(JSON.parse(cancels[0]).params).toEqual({ sessionId: 'sess-err' });
    expect(promptsSeen).toBe(1);
  });

  it('resuming a session sweeps stale turns: cancel lands before the main prompt', async () => {
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize')
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
        });
      else if (method === 'session/resume') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-old' } });
      else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const res = await turn(stream, { resumeSessionId: 'sess-old' });
    expect(res.sessionId).toBe('sess-old');
    const cancelIdx = stream.written.findIndex((l) => l.includes('"session/cancel"'));
    const promptIdx = stream.written.findIndex((l) => l.includes('"session/prompt"'));
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    // ordered on the same stream: the orphan sweep can never race the new turn
    expect(cancelIdx).toBeLessThan(promptIdx);
    expect(JSON.parse(stream.written[cancelIdx]).params).toEqual({ sessionId: 'sess-old' });
  });

  it('cancel grace skips the kill when the agent settles after cancel', async () => {
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '100' });
    try {
      // timeout fires -> session/cancel sent -> agent answers (settled) BEFORE grace -> no kill
      const stream = fakeAgent((msg, send) => {
        const method = msg.method as string | undefined;
        if (!method) return;
        if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        else if (method === 'session/prompt')
          setTimeout(
            () => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: OBLIGATION_STATUS.CANCELLED } }),
            40,
          );
      });
      const lines: string[] = [];
      const res = await turn(stream, { timeoutMs: 20, onLine: (l) => lines.push(l) });
      expect(res.stopReason).toBe(OBLIGATION_STATUS.CANCELLED);
      await new Promise((r) => setTimeout(r, 120)); // let the grace timer observe settled=true
    } finally {
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  });

  it('degenerate agent answers: missing sessionId rejects, missing text maps to empty, missing stopReason defaults to end_turn', async () => {
    const { runAcpTurn } = await import('#server/domains/tasks/acp.client');
    // session/new without a sessionId rejects
    const noSid = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
    await expect(runAcpTurn({ stream: noSid, prompt: 'x', timeoutMs: 2_000 })).rejects.toThrow('returned no sessionId');

    // agent_message text item without a text field -> empty string; stopReason absent -> end_turn
    const degenerate = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'agent_message', content: [{ type: 'text' }] } },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });
    const res = await runAcpTurn({ stream: degenerate, prompt: 'x', timeoutMs: 2_000 });
    expect(res.transcript).toBe('');
    expect(res.stopReason).toBe('end_turn');
  });

  it('chunks coalesce into real lines: newline splits, remainder flushes, paragraphs keep blanks', async () => {
    const lines: string[] = [];
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt') {
        const chunk = (text: string) =>
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            },
          });
        chunk('Hello '); // no newline yet — held
        chunk('world\nsecond line\n\n'); // flushes 'Hello world', 'second line', '' (paragraph break)
        chunk('third'); // held to turn end
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    const res = await turn(stream, { onLine: (l) => lines.push(l) });
    expect(res.transcript).toBe('Hello world\nsecond line\n\nthird');
    const textLines = lines.filter((l) => !l.startsWith('['));
    expect(textLines).toEqual(['Hello world', 'second line', '', 'third']);
  });

  it('unbroken text over 400 chars force-flushes mid-stream instead of landing at turn end', async () => {
    const lines: string[] = [];
    const long = 'a'.repeat(450);
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: long } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash' } },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    await turn(stream, { onLine: (l) => lines.push(l) });
    const i = lines.indexOf('[tool] bash');
    expect(i).toBeGreaterThan(0); // the long line flushed BEFORE the tool line
    expect(lines[i - 1]).toBe(long);
  });

  it('sparse stream shapes WITH logging: mixed content, images, partial tool metadata', async () => {
    const lines: string[] = [];
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      else if (method === 'session/prompt') {
        // full message mixing a non-text item with text — non-text maps to ''
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message',
              content: [
                { type: 'image', url: 'data:x' },
                { type: 'text', text: 'final' },
              ],
            },
          },
        });
        // image chunk: no text contribution, no log line
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } },
        });
        // empty-text chunk: appended as '' but never logged
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
          },
        });
        // tools with partial metadata
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash' } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'pending' },
          }, // ACP wire status
        });
        // usage with only one field (each side)
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'usage_update', size: 1000 } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 7 } },
        });
        // chunk with no content payload at all — ignored everywhere
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } },
        });
        // text chunk with an undefined text field — appends the ?? fallback
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } } },
        });
        // unknown update kind — falls through every logging branch untouched
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'plan', plan: [] } },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    const res = await turn(stream, { onLine: (l) => lines.push(l) });
    // v1 SDK drops the non-schema pieces: agent_message (no variant), partial usage
    // updates (both fields required), contentless chunks — transcript stays empty
    expect(res.transcript).toBe('');
    expect(lines).toContain('[tool] bash');
    expect(lines).toContain('[tool] tool pending');
    expect(lines.some((l) => l.includes('[context]'))).toBe(false);
  });

  it('onLine-less operation: sparse tool/usage/permission shapes never crash', async () => {
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        send({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} }); // no options at all
      } else if (method === 'session/new') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'tool_call' } },
        }); // no title/name/status
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: 'usage_update' } },
        }); // no used/size
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
      } else if (method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    const res = await turn(stream); // NO onLine — every logging arm must tolerate undefined
    expect(res.stopReason).toBe('end_turn');

    // timeout path with no onLine: cancel + grace kill still fire silently
    const silent = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
    });
    setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: '30' });
    try {
      await expect(turn(silent, { timeoutMs: 15 })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 60));
      expect(silent.closed).toBe(true);
    } finally {
      setEnv({ TANDEM_ACP_CANCEL_GRACE_MS: undefined });
    }
  }, 10_000);

  it('verdictFor maps stop reasons to run verdicts', async () => {
    const { verdictFor } = await import('#server/domains/tasks/acp.client');
    expect(verdictFor('end_turn')).toEqual({ status: RUN_STATUS.DONE, exitCode: 0 });
    expect(verdictFor('refusal')).toEqual({ status: RUN_STATUS.FAILED, exitCode: 1 });
    expect(verdictFor(OBLIGATION_STATUS.CANCELLED)).toEqual({ status: RUN_STATUS.FAILED, exitCode: 1 });
    expect(verdictFor('_custom')).toEqual({ status: RUN_STATUS.FAILED, exitCode: 1 });
  });

  it('prompt images ride session/prompt as image blocks after the text block (SPEC 2026-10-31)', async () => {
    let promptArg: Array<Record<string, unknown>> | null = null;
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (method === 'initialize')
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
      else if (method === 'session/prompt') {
        promptArg = (msg as { params: { prompt: Array<Record<string, unknown>> } }).params.prompt;
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    await import('#server/domains/tasks/acp.client').then(({ runAcpTurn }) =>
      runAcpTurn({
        stream,
        prompt: 'do the thing',
        images: [
          { data: 'QUJD', mimeType: 'image/png' },
          { data: 'REVG', mimeType: 'image/jpeg' },
        ],
        timeoutMs: 2_000,
      }),
    );
    expect(promptArg).toEqual([
      { type: 'text', text: 'do the thing' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      { type: 'image', data: 'REVG', mimeType: 'image/jpeg' },
    ]);
  });

  it('no images -> the prompt is the single text block (legacy shape preserved)', async () => {
    let promptArg: Array<Record<string, unknown>> | null = null;
    const stream = fakeAgent((msg, send) => {
      const method = msg.method as string | undefined;
      if (method === 'initialize')
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
      else if (method === 'session/prompt') {
        promptArg = (msg as { params: { prompt: Array<Record<string, unknown>> } }).params.prompt;
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    await import('#server/domains/tasks/acp.client').then(({ runAcpTurn }) =>
      runAcpTurn({ stream, prompt: 'do the thing', timeoutMs: 2_000 }),
    );
    expect(promptArg).toEqual([{ type: 'text', text: 'do the thing' }]);
  });

  // #284: a wire death DURING session setup (before any per-race handler exists —
  // the prompt race attaches only after openSession resolves) must never raise an
  // unhandledRejection: one handlerless rejected promise terminated the whole bun
  // process, taking every in-flight run, the dispatcher and the SSE hub with it.
  it('stream dying during the initialize await settles the turn with no unhandled rejection (#284)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const stream = fakeAgent(() => {}); // never answers initialize
      const turnP = turn(stream, {});
      turnP.catch(() => {}); // the caller's own handler rides from creation
      for (let i = 0; i < 200 && stream.written.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(stream.written.length).toBeGreaterThan(0); // initialize is on the wire
      stream.close(); // the channel dies mid-setup (bad executable / ssh drop)
      await expect(turnP).rejects.toThrow('acp stream closed'); // the turn SETTLES
      await new Promise((r) => setTimeout(r, 20)); // one macrotask for any escapee
      expect(unhandled).toEqual([]); // NO rejection escaped — the process survives
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // #285: a silent agent (alive, never answers initialize, wire never closes) —
  // the setup timeout must genuinely KILL the stream and settle the turn, never
  // log "killing" while a no-op teardown leaves the worker slot wedged for hours.
  it('silent agent: the setup timeout kills the wire and settles the turn (#285)', async () => {
    const stream = fakeAgent(() => {}); // never answers anything, wire stays open
    const lines: string[] = [];
    await expect(turn(stream, { timeoutMs: 60, onLine: (l) => lines.push(l) })).rejects.toThrow('acp stream closed');
    expect(stream.closed).toBe(true); // the timeout tore the wire down (pre-#285: still open)
    expect(lines.some((l) => l.includes('session setup timed out'))).toBe(true);
  });

  // #285: the dead-wire race covers the WHOLE setup — a wire death between
  // initialize and session/new settles the turn instead of hanging it unraced.
  it('wire death during session/new settles the turn (#285)', async () => {
    const stream = fakeAgent((msg, send, s) => {
      const method = msg.method as string | undefined;
      if (!method) return;
      if (method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
      else if (method === 'session/new') setTimeout(() => s.close(), 20); // dies before the answer
    });
    await expect(turn(stream)).rejects.toThrow('acp stream closed');
    expect(stream.closed).toBe(true);
  });
});

describe('acp-ssh transport', () => {
  it('acpRemoteCommand frames the blob by byte count and execs the ACP server', async () => {
    const { acpRemoteCommand } = await import('#server/domains/tasks/acp-ssh.util');
    expect(acpRemoteCommand(1234, 'hermes acp')).toBe(`bash -c 'eval "$(head -c 1234)" && exec hermes acp'`);
  });

  it('openAcpSshStream: blob first, then JSON-RPC; stdout/stderr lines split; close tears down', async () => {
    const { openAcpSshStream } = await import('#server/domains/tasks/acp-ssh.util');
    const plan = {
      env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' },
      sshKey: 'k',
      sshPassword: undefined,
    };
    const blob = "set -a\nCUSTOM_API_KEY='k'\nset +a\n";
    const p = openAcpSshStream(plan, blob, 'hermes acp', () => {});
    const client = await lastClient();
    client.emitReady();
    const stream = await p;
    expect(client.stream.blob).toBe(blob); // exactly the blob, nothing more
    stream.write({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(client.stream.writes.join('')).toContain('"ping"');
    // line events
    const err: string[] = [];
    let closeCode: number | null | undefined;
    stream.onStderrLine((l) => err.push(l));
    stream.onClose((c) => {
      closeCode = c;
    });
    client.stream.emitStderr('warn line\nwarn2\n');
    client.stream.emitExit(3);
    expect(err).toEqual(['warn line', 'warn2']);
    expect(closeCode).toBe(3);
    // stdout chunk WITHOUT a trailing newline stays buffered until more arrives
    const out2: string[] = [];
    stream.onStdoutLine((l) => out2.push(l));
    client.stream.emitStdout(NL_SRC + NL_SRC); // blank lines on the wire are skipped
    client.stream.emitStdout('{"partial":1');
    client.stream.emitStdout('}');
    expect(out2).toEqual([]); // nothing until a newline arrives
    client.stream.emitStdout(NL_SRC);
    expect(out2).toEqual(['{"partial":1}']);
    // ssh-stream 'close' event (vs 'exit') also reports a close code
    let closed2: number | null | undefined;
    stream.onClose((c) => {
      closed2 = c;
    });
    client.stream.close();
    expect(closed2).toBe(null);
    stream.close();
    expect(client.ended).toBe(true);
  });

  it('connects on port 22 when the plan port is empty; password auth tolerated', async () => {
    const { openAcpSshStream } = await import('#server/domains/tasks/acp-ssh.util');
    const plan = {
      env: { host: 'h', port: '', username: '00000000-0000-7000-8000-51e69892ab49' },
      sshKey: undefined,
      sshPassword: 'pw',
    };
    const p = openAcpSshStream(plan, 'blob', 'hermes acp', () => {});
    const client = await lastClient();
    client.emitReady();
    await p; // default port 22 + password arm exercised through connect()
    expect(client.stream.blob).toBe('blob');
  });

  it('passes the host-key verifier to ssh2 (host-key law, #129)', async () => {
    const { openAcpSshStream } = await import('#server/domains/tasks/acp-ssh.util');
    const plan = {
      env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' },
      sshKey: 'k',
    };
    const p = openAcpSshStream(plan, 'blob', 'hermes acp', () => {});
    const client = await lastClient();
    client.emitReady();
    await p;
    const opts = (client as unknown as { connectOpts: Record<string, unknown> | null }).connectOpts;
    expect(typeof opts?.hostVerifier).toBe('function');
  });

  it('write guards + close survives throwing signal/close + non-number exit codes', async () => {
    const { openAcpSshStream } = await import('#server/domains/tasks/acp-ssh.util');
    const plan = {
      env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' },
      sshKey: 'k',
      sshPassword: undefined,
    };
    const p = openAcpSshStream(plan, 'blob', 'hermes acp', () => {});
    const client = await lastClient();
    client.emitReady();
    const stream = await p;
    // write before the blob: impossible via runAcpTurn (open resolves after blob) —
    // simulate by destroying internals: close the transport, then write anyway
    stream.close();
    stream.write({ jsonrpc: '2.0', method: 'x' }); // both guards hit: stream gone / blob not sent
    // exit with a non-number code (agent killed by signal) reports null
    let exitCode: number | null | undefined;
    stream.onClose((c) => {
      exitCode = c;
    });
    client.stream.emitExit('SIGKILL' as unknown as number);
    expect(exitCode).toBe(null);
    // close() swallows throwing signal()/close() on the ssh stream
    const throwing = client.stream;
    throwing.signal = () => {
      throw new Error('no signal support');
    };
    throwing.close = () => {
      throw new Error('already closed');
    };
    expect(() => stream.close()).not.toThrow();
    expect(client.ended).toBe(true);
    // #262: writeRaw post-close is a silent no-op — never a throw into the SDK's
    // write queue, never a byte to the dead channel
    let bytesToDeadChannel = 0;
    (client.stream as unknown as { write: (d: unknown) => void }).write = (d: unknown) => {
      bytesToDeadChannel += 1;
      void d;
    };
    expect(() => stream.writeRaw('late frame')).not.toThrow();
    stream.write({ jsonrpc: '2.0', method: 'late' });
    expect(bytesToDeadChannel).toBe(0);
  });

  it('ssh/exec errors reject the open', async () => {
    const { openAcpSshStream } = await import('#server/domains/tasks/acp-ssh.util');
    const plan = { env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' } };
    // exec error
    let p = openAcpSshStream(plan, 'blob', 'hermes acp', () => {});
    let client = await lastClient();
    client.execError = new Error('exec nope');
    client.emitReady();
    await expect(p).rejects.toThrow('exec nope');
    // connection error
    p = openAcpSshStream(plan, 'blob', 'hermes acp', () => {});
    client = await lastClient();
    client.emitError(new Error('ECONNREFUSED'));
    await expect(p).rejects.toThrow('ECONNREFUSED');
  });
});
