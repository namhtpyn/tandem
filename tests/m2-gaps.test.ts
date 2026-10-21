// Remaining branch arms for full coverage: rpc adapter GET/no-body arms and
// ssh-probe node fallback (spawn error + null exit code).
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

import './api-harness';
import { resetSchema } from './helpers/pg';
import { applyMigrations } from '../server/db/index';
import { env, setEnv } from '../server/domains/kernel/env';
import { makeEvent } from './api-harness';

beforeEach(async () => {
  await resetSchema();
  await applyMigrations();
});

describe('/rpc adapter branch arms', () => {
  it('GET with no body builds a bodyless Request (live SSE endpoint)', async () => {
    const mod = await import('../server/routes/rpc/[...]');
    const event = makeEvent({ method: 'GET', url: '/rpc/health-nope' });
    const res = await mod.default(event);
    expect(res).toBe('Not found'); // GET outside router -> 404 text arm
  });

  it('undefined url falls back to "/" and object bodies get stringified', async () => {
    const mod = await import('../server/routes/rpc/[...]');
    const event = makeEvent({ method: 'POST', url: undefined, headers: { 'content-type': 'application/json' } });
    (event.node.req as { body?: unknown }).body = { json: { nope: 1 } }; // object -> JSON.stringify arm
    const res = await mod.default(event);
    expect(res).toBe('Not found'); // url '/' -> no procedure match -> text arm
  });
});

describe('ssh-probe (Bun.spawn)', () => {
  const ENV_ID = '00000000-0000-7000-8000-51e69892ab49';
  const realSpawn = Bun.spawn;

  function fakeProc(stdout: string, stderr: string, exit: number) {
    return {
      exited: Promise.resolve(exit),
      stdout: new Response(stdout).body!,
      stderr: new Response(stderr).body!,
      kill: vi.fn(),
    };
  }

  afterEach(() => {
    Bun.spawn = realSpawn;
    setEnv({ TANDEM_SSH_TIMEOUT_MS: undefined });
  });

  it('interprets a successful ssh run end-to-end', async () => {
    const spawn = vi.fn(() => fakeProc('tandem-probe-ok\n', '', 0));
    Bun.spawn = spawn as unknown as typeof Bun.spawn;
    const { probeSsh } = await import('../server/domains/environments/ssh-probe.service');
    const r = await probeSsh('h', '22', ENV_ID);
    expect(r).toEqual({ ok: true, detail: 'SSH key auth works' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('killed child with stderr -> ok:false, last stderr line', async () => {
    Bun.spawn = (() => fakeProc('partial', 'first line\nssh: killed by timeout', 137)) as unknown as typeof Bun.spawn;
    const { probeSsh } = await import('../server/domains/environments/ssh-probe.service');
    const r = await probeSsh('h', '22', ENV_ID);
    expect(r).toEqual({ ok: false, detail: 'ssh: killed by timeout' });
  });

  it('timeout path: timer SIGKILLs a hung child', async () => {
    setEnv({ TANDEM_SSH_TIMEOUT_MS: '30' });
    let resolveExit!: (n: number) => void;
    const kill = vi.fn(() => resolveExit(137));
    Bun.spawn = (() => ({
      exited: new Promise<number>((r) => {
        resolveExit = r;
      }),
      stdout: new Response('').body!,
      stderr: new Response('ssh: hung').body!,
      kill,
    })) as unknown as typeof Bun.spawn;
    const { probeSsh } = await import('../server/domains/environments/ssh-probe.service');
    const r = await probeSsh('h', '22', ENV_ID);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.ok).toBe(false);
  }, 10_000);

  it('spawn throw degrades to a generic message for non-Error throws', async () => {
    Bun.spawn = (() => {
      throw 'plain string failure';
    }) as unknown as typeof Bun.spawn;
    const { probeSsh } = await import('../server/domains/environments/ssh-probe.service');
    const r = await probeSsh('127.0.0.1', '22', ENV_ID);
    expect(r).toEqual({ ok: false, detail: 'probe failed' });
  });
});
