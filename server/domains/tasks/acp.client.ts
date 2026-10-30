import * as acp from '@agentclientprotocol/sdk';

import { RUN_STATUS, type FinishedStatus } from '#shared/enums';
// Structured-output contract rendering comes from the generic shared module.
import { renderOutputContract, parseStructuredOutput } from '#shared/structured-output';

import { env } from '../kernel/env';

// ACP v1 client for task dispatch, on the OFFICIAL SDK (@agentclientprotocol/sdk):
// newline-delimited JSON-RPC 2.0 over any byte duplex — an SSH exec stream in
// production, in-memory fakes in tests (bridged with writeRaw + line callbacks).
// The SDK owns framing/typing, so agent-side contract changes (the 2026-10-29
// `session/resume` Invalid params break) surface as SDK bumps, not prod fires.
//
// Laws encoded here:
// - client advertises NO fs/terminal capabilities (agents never touch Tandem)
// - one session per task: create on first dispatch, resume after (caller
//   persists the sessionId on the run row); resume is CAPABILITY-GATED
//   (agentCapabilities.sessionCapabilities.resume) and sends the full
//   spec shape { sessionId, cwd, mcpServers } — never the lazy legacy form
// - permission requests are auto-ALLOWED and logged: the one-shot dispatch this
//   replaces ran with full tool access in the employee's own sandboxed host
//   (headless parity — there is no human at this keyboard)

export type AcpStream = {
  /** send one pre-framed JSON-RPC line (newline appended here) */
  write(message: unknown): void;
  /** send raw bytes already framed as nd-json (the SDK's wire output) */
  writeRaw(text: string): void;
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

const SESSION_CWD = '/tmp';
/** grace after session/cancel before we hard-kill the stream */
function cancelGraceMs() {
  return Number(env.TANDEM_ACP_CANCEL_GRACE_MS ?? 5_000);
}

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
  /** called once the session exists — the hook receives a mid-turn steer fn
   *  (a second session/prompt on the live stream; agents queue or interrupt it) */
  onSessionOpen?: (steer: (text: string) => Promise<boolean>) => void;
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

  let transcript = '';
  let settled = false;
  /** chunk deltas coalesce here until a real newline — one log line per source line, not per chunk */
  let pendingLine = '';
  /** notifications ([context]/[tool]) arriving mid-chunk-line queue here — printing
   * them directly would split a half-streamed envelope JSON into invalid pieces */
  const queuedLogLines: string[] = [];
  const queueLogLine = (line: string) => {
    queuedLogLines.push(line);
  };
  const drainQueuedLogLines = () => {
    if (!pendingLine && queuedLogLines.length) {
      for (const line of queuedLogLines.splice(0)) onLine?.(line);
    }
  };
  const LINE_FLUSH_MAX = 400;
  const emitChunkText = (text: string) => {
    pendingLine += text;
    let nl = pendingLine.indexOf('\n');
    while (nl >= 0) {
      onLine?.(pendingLine.slice(0, nl));
      pendingLine = pendingLine.slice(nl + 1);
      nl = pendingLine.indexOf('\n');
    }
    drainQueuedLogLines();
    // very long unbroken text still streams instead of landing as one blob at turn end
    if (pendingLine.length >= LINE_FLUSH_MAX) {
      onLine?.(pendingLine);
      pendingLine = '';
      drainQueuedLogLines();
    }
  };
  const flushPendingLine = () => {
    if (pendingLine) {
      onLine?.(pendingLine);
      pendingLine = '';
    }
    for (const line of queuedLogLines.splice(0)) onLine?.(line);
  };

  /** upsert semantics from the spec: full message replaces, chunk appends.
   * `update` is the SDK's typed SessionUpdate union (usage_update included). */
  // stream every human-meaningful update into the run output (live progress);
  // extracted so the connectWith callback stays under the complexity gate
  const logUpdateProgress = (kind: string, update: { sessionUpdate: string } & Record<string, unknown>) => {
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title =
        typeof update.title === 'string'
          ? update.title
          : typeof update.toolName === 'string'
            ? update.toolName
            : 'tool';
      const status = typeof update.status === 'string' ? ` ${update.status}` : '';
      queueLogLine(`[tool] ${title}${status}`);
    } else if (kind === 'usage_update') {
      queueLogLine(`[context] ${update.used ?? '?'}/${update.size ?? '?'} tokens`);
    }
    // user_message_chunk (our own prompt echo) and plans stay out of the log
  };

  const applyUpdate = (update: { sessionUpdate: string } & Record<string, unknown>) => {
    const kind = update.sessionUpdate;
    // (v1 has no full-message variant — chunks are the only text carrier)
    if (kind === 'agent_message_chunk') {
      const c = update.content as { type: string; text?: string } | undefined;
      if (c && c.type === 'text') {
        const t = c.text ?? '';
        transcript += t;
        if (t) emitChunkText(t);
      }
    }
    logUpdateProgress(kind, update);
  };

  let teardown: () => void = () => {};
  let notifyCancel: (sessionId: string) => void = () => {};

  const stdoutBridge = StdoutBridge(stream);
  // agent stderr streams as diagnostics; a dead stream ENDS the wire (in-flight
  // requests reject — never hang) and flushes the pending line
  stream.onStderrLine((line) => onLine?.(`[acp] ${line}`));
  // a dead stream must also REJECT the in-flight turn: Bun's web-stream error
  // propagation can leave the SDK's request pending forever, so we race a
  // dead-wire promise against every awaited agent response
  let deadReject: ((e: Error) => void) | null = null;
  const dead = new Promise<never>((_, reject) => {
    deadReject = reject;
  });
  stream.onClose(() => {
    flushPendingLine();
    stdoutBridge.end();
    teardown();
    deadReject?.(new Error('acp stream closed'));
  });

  // initialize + capability-gated resume/fresh-session (v1 spec shape: sessionId+cwd+
  // mcpServers — the lazy legacy form is what Invalid-params'd 2026-10-29). Setup
  // shares the run timeout: a silent agent must fail the turn, never hang it.
  const openSession = async (ctx: acp.ClientContext): Promise<string | null> => {
    const setupTimer = setTimeout(() => {
      onLine?.('[acp] session setup timed out — killing the agent process');
      teardown();
    }, timeoutMs);
    setupTimer.unref?.();
    try {
      const init = await ctx.request<acp.InitializeResponse, acp.InitializeRequest>(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo,
      });
      const resumeId = opts.resumeSessionId?.trim() || null;
      const canResume = Boolean(
        resumeId &&
        ((init.agentCapabilities as { sessionCapabilities?: { resume?: unknown } } | undefined)?.sessionCapabilities
          ?.resume ??
          false),
      );
      if (resumeId && canResume) {
        try {
          await ctx.request(acp.methods.agent.session.resume, {
            sessionId: resumeId,
            cwd: SESSION_CWD,
            mcpServers: [],
          });
          // orphan sweep: the previous run on this session may have died with its
          // turn still executing in the agent's gateway. Cancelling HERE is ordered
          // before the main prompt on the same stream — a no-op when idle, a kill
          // when a stale turn lingers. (Prod 2026-10-29: a resumed session met its
          // own still-running zombie.)
          await ctx.notify(acp.methods.agent.session.cancel, { sessionId: resumeId }).catch(() => {});
          return resumeId;
        } catch (e) {
          onLine?.(
            `[acp] session resume failed (${e instanceof Error ? e.message : String(e)}); starting a new session`,
          );
        }
      } else if (resumeId) {
        onLine?.('[acp] agent does not advertise session resume — starting a new session');
      }
      const created = await ctx.request<acp.NewSessionResponse, acp.NewSessionRequest>(acp.methods.agent.session.new, {
        cwd: SESSION_CWD,
        mcpServers: [],
      });
      return created.sessionId;
    } finally {
      clearTimeout(setupTimer);
    }
  };

  const turnPromise = acp
    .client({ name: clientInfo.name })
    .onRequest(acp.methods.client.session.requestPermission, (rctx) => {
      // headless parity: auto-select the agent's own allow option (there is no
      // human at this keyboard — the sandboxed host is the permission boundary)
      const options = rctx.params.options ?? [];
      const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
      if (allow) {
        onLine?.(`[permission] allowed: ${allow.name}`);
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    })
    .onNotification(acp.methods.client.session.update, (nctx) => {
      applyUpdate(nctx.params.update);
    })
    .connectWith(
      acp.ndJsonStream(WritableStreamBridge(stream), stdoutBridge.readable),
      async (ctx: acp.ClientContext) => {
        const sessionId = await openSession(ctx);
        if (!sessionId) throw new Error('acp session setup returned no sessionId');

        notifyCancel = (sid: string) => void ctx.notify(acp.methods.agent.session.cancel, { sessionId: sid });
        teardown = () => {
          try {
            stream.close();
          } catch {
            /* already gone */
          }
        };

        if (opts.onSessionOpen) {
          opts.onSessionOpen(async (text: string) => {
            try {
              await ctx.request(acp.methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text }],
              });
              return true;
            } catch {
              /* v8 ignore next -- request() rejects on error frames; a throw is transport-level */
              return false;
            }
          });
        }

        // 3. one prompt turn; v1 answers when the turn ends (stopReason)
        const turnTimer = setTimeout(() => {
          onLine?.('[acp] turn timed out — sending session/cancel');
          notifyCancel(sessionId);
          setTimeout(() => {
            if (!settled) {
              onLine?.('[acp] cancel grace elapsed — killing the agent process');
              teardown();
            }
          }, cancelGraceMs()).unref?.();
        }, timeoutMs);
        turnTimer.unref?.();

        let prompt: { stopReason?: string };
        try {
          prompt = await Promise.race([
            ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: 'text', text: promptText }],
            }),
            dead,
          ]);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // the turn lives in the agent's gateway, not on this wire: a JSON-RPC
          // rejection (wire still open) leaves it RUNNING unless we cancel it.
          // Prod 2026-10-29: a -32603 prompt failure orphaned a turn that kept
          // burning tokens for 15+ minutes after Tandem marked the run failed.
          if (message !== 'acp stream closed') {
            await ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
          }
          throw new Error(`acp session/prompt failed: ${message} (transcript so far: ${transcript.slice(0, 500)})`);
        }
        clearTimeout(turnTimer);
        settled = true;
        const stopReason = (prompt.stopReason ?? 'end_turn') as StopReason;
        if (opts.outputSchema) {
          const structured = await parseStructuredOutput(transcript, opts.outputSchema);
          return { sessionId, stopReason, transcript, structured } as [S] extends [never]
            ? AcpTurnResult
            : AcpStructuredTurnResult<S>;
        }
        return { sessionId, stopReason, transcript } as [S] extends [never]
          ? AcpTurnResult
          : AcpStructuredTurnResult<S>;
      },
    );

  // the streamed tail flushes AFTER the turn settles — mid-turn it flows through
  // the chunk emitter (never newline-terminated final text still reaches the log)
  try {
    return (await turnPromise) as [S] extends [never] ? AcpTurnResult : AcpStructuredTurnResult<S>;
  } finally {
    // the harness session persists on the agent host; the PROCESS does not
    flushPendingLine();
    teardown();
  }
}

/** bridge the AcpStream's line callbacks into the SDK's web-stream wire */
function WritableStreamBridge(stream: AcpStream): WritableStream<Uint8Array> {
  const decoder = new TextDecoder();
  return new WritableStream<Uint8Array>({
    write(chunk) {
      stream.writeRaw(decoder.decode(chunk));
    },
  });
}

function StdoutBridge(stream: AcpStream): { readable: ReadableStream<Uint8Array>; end: () => void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      stream.onStdoutLine((line) => {
        try {
          c.enqueue(encoder.encode(`${line}\n`));
        } catch {
          /* closed — late lines dropped */
        }
      });
    },
  });
  return {
    readable,
    // a dead stream ENDS the wire: the SDK then rejects in-flight requests instead
    // of hanging the turn (the hand-rolled client resolved pendings on close)
    end: () => {
      try {
        // ERROR (not close): a closed stream leaves in-flight requests hanging —
        // an errored one rejects every pending request immediately
        nonNull(controller).error(new Error('acp stream closed'));
      } catch {
        /* already ended */
      }
    },
  };
}

/** map an ACP stopReason to the run verdict */
export function verdictFor(stopReason: string): { status: FinishedStatus; exitCode: number } {
  if (stopReason === 'end_turn') return { status: RUN_STATUS.DONE, exitCode: 0 };
  return { status: RUN_STATUS.FAILED, exitCode: 1 };
}
