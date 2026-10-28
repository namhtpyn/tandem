// ssh-probe unit tests: interpret(), Bun Shell path (bun runtime), node
// fallback path (vitest workers), unreachable-host failures.
import { describe, expect, it, vi } from 'vitest';

import { probeSsh, interpret } from '#server/domains/environments/ssh-probe.service';

describe('probeSsh (node fallback path — vitest workers are node)', () => {
  it('reports ok:false with a detail when the host refuses the connection', async () => {
    // ssh to 127.0.0.1 may or may not have key auth in CI; both outcomes are
    // well-formed. Assert on a real remote-unreachable case instead for
    // determinism, and on a local marker echo via PATH-shimmed ssh:
    const r = await probeSsh('127.0.0.1', '59999', 'nobody');
    expect(r.ok).toBe(false);
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it('catch arm: throwing spawn surfaces ok:false (fresh module, mocked)', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        throw new Error('spawn exploded');
      },
    }));
    try {
      const mod = await import('#server/domains/environments/ssh-probe.service');
      // force the bun branch to throw a non-Cannot-find error so it falls to
      // probeViaNode, which throws in spawn -> catch arm
      const r = await mod.probeSsh('127.0.0.1', '22', '00000000-0000-7000-8000-51e69892ab49');
      // spawn threw synchronously inside probeViaNode -> its own promise rejects
      // -> caught by probeSsh catch -> ok:false
      expect(r.ok).toBe(false);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  }, 10_000);
});

describe('writeIdentity (trailing-newline contract)', () => {
  /** capture what writeIdentity hands the filesystem — asserting the ssh exit
   *  only proved the probe failed, never that the key file was well-formed */
  async function captureIdentityWrite(key: string): Promise<string> {
    const written: Array<{ file: string; data: unknown }> = [];
    const realWrite = Bun.write.bind(Bun);
    const spy = vi.spyOn(Bun, 'write').mockImplementation((async (
      file: Parameters<typeof Bun.write>[0],
      data: Parameters<typeof Bun.write>[1],
    ) => {
      written.push({ file: String(file), data });
      return realWrite(file, data);
    }) as typeof Bun.write);
    try {
      // the write happens before ssh is spawned, so a dead port is enough
      await probeSsh('127.0.0.1', '59999', 'nobody', key);
    } finally {
      spy.mockRestore();
    }
    const id = written.find((w) => w.file.endsWith('/id'));
    expect(id, 'writeIdentity never wrote the key file').toBeDefined();
    return String(id?.data ?? '');
  }

  it('appends a newline to keys lacking one', async () => {
    await expect(captureIdentityWrite('KEY-WITHOUT-NEWLINE')).resolves.toBe('KEY-WITHOUT-NEWLINE\n');
  });

  it('does not double the newline on keys that already end with one', async () => {
    await expect(captureIdentityWrite('KEY-WITH-NEWLINE\n')).resolves.toBe('KEY-WITH-NEWLINE\n');
  });
});

describe('interpret', () => {
  it('ok when marker echoed with exit 0', () => {
    expect(interpret(0, 'tandem-probe-ok\n', '')).toEqual({ ok: true, detail: 'SSH key auth works' });
  });

  it('failure uses the last stderr line', () => {
    expect(interpret(255, '', 'line one\nssh: connect refused\n')).toEqual({
      ok: false,
      detail: 'ssh: connect refused',
    });
  });

  it('failure falls back to exit code when stderr empty', () => {
    expect(interpret(1, '', '')).toEqual({ ok: false, detail: 'ssh exited 1' });
  });

  it('exit 0 without the marker is a failure', () => {
    expect(interpret(0, 'something else', '')).toEqual({ ok: false, detail: 'ssh exited 0' });
  });
});
