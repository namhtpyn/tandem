// Structured-output contract rendering comes from the generic shared module.
import { renderOutputContract, parseStructuredOutput } from '#shared/structured-output';
import { RUN_STATUS, type FinishedStatus } from '#shared/enums';

// Minimal ACP v1 client for task dispatch: newline-delimited JSON-RPC 2.0 over
// any byte duplex — an SSH exec stream in production, PassThrough pairs in
// tests. Deliberately hand-rolled (no SDK): the surface we need is small
// (initialize / session new+resume / prompt / cancel / update notifications)
// and staying dependency-free keeps the 100%-coverage law cheap.
//
// Laws encoded here:
// - client advertises NO fs/terminal capabilities (agents never touch Tandem)
// - one session per task: create on first dispatch, resume after (caller
//   persists the sessionId on the task row)
// - permission requests are auto-ALLOWED and logged: the one-shot dispatch this
//   replaces ran with full tool access in the employee's own sandboxed host
//   (headless parity — there is no human at this keyboard)

export type AcpStream = {
  /** send one JSON-RPC message (newline appended here) */
  write(message: unknown): void;
  /** tear down the underlying process/connection */
  close(): void;
  /** ACP JSON-RPC lines from the agent's stdout */
  onStdoutLine(cb: (line: string) => void): void;
  /** non-ACP diagnostics from the agent's stderr */
  onStderrLine(cb: (line: string) => void): void;
  /** underlying stream ended; code is the remote exit code when known */
  onClose(cb: (code: number | null) => void): void;
};

export type StopReason = 'end_turn' | 'refusal' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | `_${string}`;

export type AcpTurnResult = {
  sessionId: string;
  stopReason: StopReason;
  /** final agent message text (chunks concatenated in arrival order) */
  transcript: string;
};

/** an ACP turn with a structured-output contract: pass any zod schema and the
 * client renders the output contract onto the prompt and parses the trailing
 * JSON against the schema (null when the agent ignored the contract). */
export interface AcpStructuredTurnResult<S extends import('zod').ZodType> extends AcpTurnResult {
  structured: import('zod').infer<S> | null;
}

type RpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

const PROTOCOL_VERSION = 1;
/** grace after session/cancel before we hard-kill the stream */
const CANCEL_GRACE_MS = Number(process.env.TANDEM_ACP_CANCEL_GRACE_MS ?? 5_000);

export async function runAcpTurn<S extends import('zod').ZodType = never>(opts: {
  stream: AcpStream;
  /** task's existing harness session; falsy = create a new one */
  resumeSessionId?: string | null;
  prompt: string;
  timeoutMs: number;
  /** human-visible activity lines (streamed into the run output) */
  onLine?: (line: string) => void;
  clientInfo?: { name: string; version: string };
  /** optional structured-output contract: rendered onto the prompt and parsed
   *  from the trailing JSON on completion — generic, any zod schema */
  outputSchema?: S;
  /** extra lines appended after the auto-rendered contract (e.g. examples) */
  outputContractExtras?: string[];
}): Promise<[S] extends [never] ? AcpTurnResult : AcpStructuredTurnResult<S>> {
  const { stream, timeoutMs, onLine } = opts;
  // promptText: the caller's prompt plus the auto-rendered structured-output
  // contract (kept separate from the later session/prompt RESULT binding)
  let promptText = opts.prompt;
  if (opts.outputSchema) {
    const contract = renderOutputContract(opts.outputSchema, { examples: opts.outputContractExtras });
    promptText = `${promptText}\n\n${contract}`;
  }
  const clientInfo = opts.clientInfo ?? { name: 'tandem', version: '1' };

  let nextId = 1;
  const pending = new Map<number, { resolve: (m: RpcMessage) => void }>();
  let transcript = '';
  let settled = false;
  /** chunk deltas coalesce here until a real newline — one log line per source line, not per chunk */
  let pendingLine = '';
  let streamedText = false;
  const LINE_FLUSH_MAX = 400;
  const emitChunkText = (text: string) => {
    pendingLine += text;
    let nl = pendingLine.indexOf('\n');
    while (nl >= 0) {
      onLine?.(pendingLine.slice(0, nl));
      pendingLine = pendingLine.slice(nl + 1);
      nl = pendingLine.indexOf('\n');
    }
    // very long unbroken text still streams instead of landing as one blob at turn end
    if (pendingLine.length >= LINE_FLUSH_MAX) {
      onLine?.(pendingLine);
      pendingLine = '';
    }
  };
  const flushPendingLine = () => {
    if (pendingLine) {
      onLine?.(pendingLine);
      pendingLine = '';
    }
  };

  const request = (method: string, params: unknown): Promise<RpcMessage> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      stream.write({ jsonrpc: '2.0', id, method, params });
    });

  const notify = (method: string, params: unknown) => stream.write({ jsonrpc: '2.0', method, params });

  /** upsert semantics from the spec: full message replaces, chunk appends */
  const applyUpdate = (update: Record<string, unknown>) => {
    const kind = update.sessionUpdate;
    if (kind === 'agent_message' && Array.isArray(update.content)) {
      flushPendingLine();
      transcript = (update.content as Array<{ type: string; text?: string }>)
        .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('');
      // streaming harnesses already logged their lines; non-streaming ones get the full text once
      if (!streamedText && transcript) {
        streamedText = true;
        onLine?.(transcript);
      }
    } else if (kind === 'agent_message_chunk') {
      const c = update.content as { type: string; text?: string } | undefined;
      if (c && c.type === 'text') {
        const t = c.text ?? '';
        transcript += t;
        if (t) {
          streamedText = true;
          emitChunkText(t);
        }
      }
    }
    // stream every human-meaningful update into the run output (live progress)
    if (onLine) {
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const title =
          typeof update.title === 'string'
            ? update.title
            : typeof update.toolName === 'string'
              ? update.toolName
              : 'tool';
        const status = typeof update.status === 'string' ? ` ${update.status}` : '';
        onLine(`[tool] ${title}${status}`);
      } else if (kind === 'usage_update') {
        onLine(`[context] ${update.used ?? '?'}/${update.size ?? '?'} tokens`);
      }
      // user_message_chunk (our own prompt echo) and plans stay out of the log
    }
  };

  const handleAgentMessage = (msg: RpcMessage) => {
    if (msg.id !== undefined && msg.method) {
      // agent -> client REQUEST: permissions auto-allow; fs/terminal denied (not advertised)
      if (msg.method === 'session/request_permission') {
        const p = msg.params as { options?: Array<{ id: string; title?: string }> } | undefined;
        for (const o of p?.options ?? []) onLine?.(`[permission] allowed: ${o.title ?? o.id}`);
        stream.write({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'allow' } } });
        return;
      }
      // v2-style elicitation / anything else we never advertised: method not found
      stream.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `tandem does not support ${msg.method}` },
      });
      return;
    }
    if (msg.method === 'session/update') {
      const p = msg.params as { update?: Record<string, unknown> } | undefined;
      if (p?.update) applyUpdate(p.update);
      return;
    }
    if (msg.method === 'session/cancel') {
      // v2 agent-initiated cancel of the current turn — treat as turn end
      onLine?.('[acp] agent cancelled the turn');
    }
  };

  /** parse + dispatch every stdout line from the moment the stream opens */
  const processLine = (raw: string) => {
    let msg: RpcMessage | null = null;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      onLine?.(`[acp] non-JSON stdout: ${raw.slice(0, 200)}`);
      return;
    }
    handleAgentMessage(msg);
    const mid = msg.id;
    if (typeof mid === 'number' && pending.has(mid)) {
      pending.get(mid)!.resolve(msg);
      pending.delete(mid);
    }
  };
  stream.onStdoutLine(processLine);
  stream.onStderrLine((line) => onLine?.(`[acp] ${line}`));

  let closed: ((code: number | null) => void) | null = null;
  const closedPromise = new Promise<number | null>((resolve) => {
    closed = resolve;
  });
  stream.onClose((code) => {
    closed?.(code);
    // unblock any pending waits — a dead stream must never hang the run
    for (const [, p] of pending) p.resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'acp stream closed' } });
    pending.clear();
  });

  const teardown = () => {
    try {
      stream.close();
    } catch {
      /* already gone */
    }
  };

  try {
    // 1. initialize (no fs/terminal capabilities — Tandem exposes nothing)
    const init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo,
    });
    if (init.error) throw new Error(`acp initialize failed: ${init.error.message}`);

    // 2. session: resume the task's session, or create the first one
    let sessionId = opts.resumeSessionId?.trim() || null;
    if (sessionId) {
      const res = await request('session/resume', { sessionId });
      if (res.error) {
        // stale/reset session on the agent side: fall back to a fresh one
        onLine?.(`[acp] session resume failed (${res.error.message}); starting a new session`);
        sessionId = null;
      } else {
        const sid = (res.result as { sessionId?: string } | undefined)?.sessionId;
        if (sid) sessionId = sid;
      }
    }
    if (!sessionId) {
      const res = await request('session/new', { cwd: '/tmp', mcpServers: [] });
      if (res.error) throw new Error(`acp session/new failed: ${res.error.message}`);
      sessionId = (res.result as { sessionId?: string } | undefined)?.sessionId ?? null;
      if (!sessionId) throw new Error('acp session/new returned no sessionId');
    }

    // 3. one prompt turn; v1 answers when the turn ends (stopReason)
    const turnTimer = setTimeout(() => {
      onLine?.('[acp] turn timed out — sending session/cancel');
      notify('session/cancel', { sessionId });
      setTimeout(() => {
        if (!settled) {
          onLine?.('[acp] cancel grace elapsed — killing the agent process');
          teardown();
        }
      }, CANCEL_GRACE_MS).unref?.();
    }, timeoutMs);
    turnTimer.unref?.();

    const prompt = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    clearTimeout(turnTimer);
    settled = true;

    if (prompt.error) {
      throw new Error(
        `acp session/prompt failed: ${prompt.error.message} (transcript so far: ${transcript.slice(0, 500)})`,
      );
    }
    const stopReason = ((prompt.result as { stopReason?: string } | undefined)?.stopReason ?? 'end_turn') as StopReason;
    if (opts.outputSchema) {
      const structured = await parseStructuredOutput(transcript, opts.outputSchema);
      return { sessionId, stopReason, transcript, structured } as [S] extends [never]
        ? AcpTurnResult
        : AcpStructuredTurnResult<S>;
    }
    return { sessionId, stopReason, transcript } as [S] extends [never] ? AcpTurnResult : AcpStructuredTurnResult<S>;
  } finally {
    // anything the agent never newline-terminated still reaches the log
    flushPendingLine();
    // the harness session persists on the agent host; the PROCESS does not
    teardown();
    void closedPromise;
  }
}

/** map an ACP stopReason to the run verdict */
export function verdictFor(stopReason: string): { status: FinishedStatus; exitCode: number } {
  if (stopReason === 'end_turn') return { status: RUN_STATUS.DONE, exitCode: 0 };
  return { status: RUN_STATUS.FAILED, exitCode: 1 };
}
