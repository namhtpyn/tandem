// ssh-exec stream logic against a mocked ssh2 transport: stdout lines,
// stderr prefixing, exec error, connection error, exit codes.
import { describe, expect, it, vi, beforeEach } from 'vitest';

// runOverSsh lê o cap de run da Settings page — mock sem banco de dados
vi.mock('#server/domains/settings/settings.service', () => ({
  getRunTimeoutMs: async () => 10_000,
}));

vi.mock('ssh2', () => {
  class FakeStream {
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    stderrHandlers: Array<(d: unknown) => void> = [];
    ended = false;
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      if (ev === 'data') return this;
      return this;
    }
    emitStdout(text: string) {
      (this.handlers['data'] ?? []).forEach((f) => f(Buffer.from(text)));
    }
    emitStderr(text: string) {
      this.stderrHandlers.forEach((f) => f(Buffer.from(text)));
    }
    close(code: number | null) {
      this.ended = true;
      (this.handlers['close'] ?? []).forEach((f) => f(code));
    }
    end(_data?: string) {
      /* captured by the exec caller */
    }
  }
  // make .stderr.on work
  const wrap = (stream: FakeStream) => {
    (stream as unknown as Record<string, unknown>).stderr = {
      on: (_ev: string, fn: (d: unknown) => void) => {
        stream.stderrHandlers.push(fn);
      },
    };
    return stream;
  };
  class FakeClient {
    /** exec means the stream handlers are attached — the signal clientReady waits on */
    static execs = 0;
    /** planted BEFORE the run starts — no sleep-and-hope race with the ready tick */
    static nextExecError: Error | null = null;
    static last: FakeClient;
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    execHandler: ((err: Error | null, stream: unknown) => void) | null = null;
    ended = false;
    execError: Error | null = null;
    stream = wrap(new FakeStream());
    /** captured .connect() options — lets tests assert what the util dialled */
    connectOpts: Record<string, unknown> | null = null;
    constructor() {
      FakeClient.last = this;
    }
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      return this;
    }
    exec(_cmd: string, cb: (err: Error | null, stream: unknown) => void) {
      this.execHandler = cb;
      FakeClient.execs += 1;
      cb(this.execError ?? FakeClient.nextExecError, this.stream);
    }
    end() {
      this.ended = true;
    }
    connect(opts: Record<string, unknown>) {
      this.connectOpts = opts;
      // default: ready fires next tick
      setTimeout(
        () =>
          (this.handlers['ready'] ?? []).forEach((f) => {
            (f as () => void)();
          }),
        0,
      );
    }
    emitError(err: Error) {
      (this.handlers['error'] ?? []).forEach((f) => f(err));
    }
  }
  return { default: { Client: FakeClient } };
});

import { runOverSsh } from '#server/domains/tasks/ssh-exec.util';
import { RUN_STATUS } from '#shared/enums';

const plan = {
  env: { host: 'h', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' },
  sshKey: 'k',
  sshPassword: undefined,
};

async function collected() {
  const lines: string[] = [];
  let finishState: { status: string; exitCode: number | null } | null = null;
  let resolved: { status: string; exitCode: number | null } | null = null;
  const finish = async (status: RUN_STATUS.DONE | RUN_STATUS.FAILED, exitCode: number | null) => {
    finishState = { status, exitCode };
  };
  const resolve = (v: { status: string; exitCode: number | null }) => {
    resolved = v;
  };
  return { lines, finish, resolve, state: () => ({ finishState, resolved }) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // statics survive between tests — a stale exec count made clientReady resolve
  // before THIS run had attached its stream handlers
  const { default: FakeClientModule } = await import('ssh2');
  const statics = FakeClientModule.Client as unknown as { execs: number; nextExecError: Error | null };
  statics.execs = 0;
  statics.nextExecError = null;
});

/** the fake ssh2 client the service constructed — awaited, never slept on */
type FakeClientShape = {
  stream: { emitStdout(t: string): void; emitStderr(t: string): void; close(c: number | null): void };
  execError: Error | null;
  emitError(e: Error): void;
};
async function clientReady(): Promise<FakeClientShape> {
  const clientMod = (await import('ssh2')).default;
  const FakeClient = clientMod.Client as unknown as { last?: FakeClientShape; execs: number };
  // `last` alone is not enough: the service only wires the stream inside exec,
  // which runs after the fake's ready tick — emitting before that drops events
  await vi.waitFor(() => expect(FakeClient.execs).toBeGreaterThan(0));
  return FakeClient.last as FakeClientShape;
}

describe('runOverSsh (mocked ssh2)', () => {
  it('streams stdout lines, prefixes stderr, closes done on exit 0', async () => {
    const { lines, finish, resolve, state } = await collected();
    const p = runOverSsh(plan, 'cmd', 'blob', (l) => lines.push(l), finish, resolve as never);
    const client = await clientReady();
    client.stream.emitStdout('line1\nline2\n');
    client.stream.emitStderr('warn\n');
    client.stream.close(0);
    await p;
    // runOverSsh resolves once connect() is called — the settle lands later, so
    // wait on the observable state instead of sleeping
    await vi.waitFor(() => expect(state().finishState).not.toBeNull());
    const s = state();
    expect(lines).toEqual(['line1', 'line2', '[stderr] warn']);
    expect(s.finishState).toEqual({ status: RUN_STATUS.DONE, exitCode: 0 });
    expect(s.resolved).toEqual({ status: RUN_STATUS.DONE, exitCode: 0 });
  });

  it('nonzero exit marks the run failed', async () => {
    const { lines, finish, resolve, state } = await collected();
    const p = runOverSsh(plan, 'cmd', 'blob', (l) => lines.push(l), finish, resolve as never);
    const client = await clientReady();
    client.stream.close(3);
    await p;
    await vi.waitFor(() => expect(state().finishState).toEqual({ status: RUN_STATUS.FAILED, exitCode: 3 }));
    const s = state();
  });

  it('exec error fails the run without streaming', async () => {
    const { lines, finish, resolve, state } = await collected();
    const clientMod = (await import('ssh2')).default;
    const Ctor = clientMod.Client as unknown as { nextExecError: Error | null };
    // plant the error BEFORE the run: the fake applies it at exec time, so there
    // is no sleep-and-hope race against the constructor or the ready tick
    Ctor.nextExecError = new Error('exec blew up');
    const p = runOverSsh(plan, 'cmd', 'blob', (l) => lines.push(l), finish, resolve as never);
    await p;
    await vi.waitFor(() => expect(state().finishState).toEqual({ status: RUN_STATUS.FAILED, exitCode: null }));
    const s = state();
  });

  it('connection error surfaces as failed with the message on the stream', async () => {
    const { lines, finish, resolve, state } = await collected();
    const p = runOverSsh({ ...plan, sshKey: undefined }, 'cmd', 'blob', (l) => lines.push(l), finish, resolve as never);
    const client = await clientReady();
    client.emitError(new Error('ECONNREFUSED'));
    await p;
    await vi.waitFor(() => expect(lines.some((l) => l.includes('ECONNREFUSED'))).toBe(true));
    const s = state();
    expect(s.finishState).toEqual({ status: RUN_STATUS.FAILED, exitCode: null });
  });

  it('port defaults to 22 on garbage', async () => {
    const { lines, finish, resolve } = await collected();
    const clientMod = (await import('ssh2')).default;
    const FakeClient = clientMod.Client as unknown as {
      last: { connectOpts: Record<string, unknown> | null; stream: { close(c: number | null): void } };
    };
    const p = runOverSsh(
      { env: { host: 'h', port: 'x', username: '00000000-0000-7000-8000-51e69892ab49' } as never, sshKey: 'k' },
      'cmd',
      'blob',
      (l) => lines.push(l),
      finish,
      resolve as never,
    );
    // connect fires on the util's first tick — poll for the captured options
    await vi.waitFor(() => expect(FakeClient.last.connectOpts).not.toBeNull());
    // the REAL assertion: garbage port dials the ssh2 default
    expect(FakeClient.last.connectOpts?.port).toBe(22);
    FakeClient.last.stream.close(0);
    await p;
  });
});
