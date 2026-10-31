import { consola } from 'consola';
// SSH host-key TOFU seam (SPEC: Environments procedures — host-key law, #129).
// Fingerprint format, first-contact accept+persist, known-key pass, mismatch
// fail-closed with the audit line, and the ssh2 hostVerifier callback contract
// (verify() MUST be invoked; the adapter itself must return undefined — a
// returned Promise would be passed to ssh2's verify() verbatim and count as
// truthy, silently accepting every host).
import { describe, expect, it, vi } from 'vitest';

import { hostKeyFingerprint, sshHostVerifier, verifyHostKey } from '#server/domains/tasks/ssh-hostkey.util';

const KEY_A = Buffer.from('wire-format-host-key-A');
const KEY_B = Buffer.from('wire-format-host-key-B');

describe('hostKeyFingerprint', () => {
  it('is sha256:<base64 nopad>, deterministic, key-sensitive', () => {
    const fp = hostKeyFingerprint(KEY_A);
    expect(fp).toMatch(/^sha256:[A-Za-z0-9+/]+$/); // no '=' padding
    expect(fp).toBe(hostKeyFingerprint(Buffer.from('wire-format-host-key-A')));
    expect(fp).not.toBe(hostKeyFingerprint(KEY_B));
  });
});

describe('verifyHostKey (TOFU decision)', () => {
  it('first contact: accepts and persists the fingerprint', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const ok = await verifyHostKey({ envId: 'env-1', knownHostFingerprint: null, saveHostFingerprint: save }, KEY_A);
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith(hostKeyFingerprint(KEY_A));
  });

  it('known key match: accepts without re-persisting', async () => {
    const save = vi.fn();
    const ok = await verifyHostKey(
      { envId: 'env-1', knownHostFingerprint: hostKeyFingerprint(KEY_A), saveHostFingerprint: save },
      KEY_A,
    );
    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('stored mismatch: fails closed with the audit line, never persists', async () => {
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
    const save = vi.fn();
    try {
      const ok = await verifyHostKey(
        { envId: 'env-1', knownHostFingerprint: hostKeyFingerprint(KEY_A), saveHostFingerprint: save },
        KEY_B,
      );
      expect(ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
      const line = String(errSpy.mock.calls[0]?.[0]);
      expect(line).toContain('HOST KEY MISMATCH');
      expect(line).toContain('env=env-1');
      expect(line).toContain(hostKeyFingerprint(KEY_A));
      expect(line).toContain(hostKeyFingerprint(KEY_B));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('first-contact persist failure degrades to accept-new (mismatch guard intact)', async () => {
    const warnSpy = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error('db down'));
    try {
      const ok = await verifyHostKey({ envId: 'env-1', knownHostFingerprint: null, saveHostFingerprint: save }, KEY_A);
      expect(ok).toBe(true);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('persist failed');
      // the stored fingerprint still guards once persisted
      const mismatch = await verifyHostKey({ envId: 'env-1', knownHostFingerprint: hostKeyFingerprint(KEY_A) }, KEY_B);
      expect(mismatch).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('sshHostVerifier (ssh2 callback contract)', () => {
  it('invokes verify(true/false) asynchronously and returns undefined', async () => {
    const verifier = sshHostVerifier({ knownHostFingerprint: hostKeyFingerprint(KEY_A) });

    let matched: boolean | undefined;
    const ret = verifier(KEY_A, (ok) => {
      matched = ok;
    });
    expect(ret).toBeUndefined(); // a returned value would bypass the async bridge
    await vi.waitFor(() => expect(matched).toBe(true));

    let mismatched: boolean | undefined;
    verifier(KEY_B, (ok) => {
      mismatched = ok;
    });
    await vi.waitFor(() => expect(mismatched).toBe(false));
  });

  it('first contact through the adapter persists and accepts', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const verifier = sshHostVerifier({ envId: 'env-9', knownHostFingerprint: null, saveHostFingerprint: save });
    let decided: boolean | undefined;
    verifier(KEY_A, (ok) => {
      decided = ok;
    });
    await vi.waitFor(() => expect(decided).toBe(true));
    expect(save).toHaveBeenCalledWith(hostKeyFingerprint(KEY_A));
  });

  it('a rejected decision path still calls verify(false) (never hangs the handshake)', async () => {
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
    try {
      const verifier = sshHostVerifier({ knownHostFingerprint: 'sha256:stale' });
      let decided: boolean | undefined;
      verifier(KEY_A, (ok) => {
        decided = ok;
      });
      await vi.waitFor(() => expect(decided).toBe(false));
    } finally {
      errSpy.mockRestore();
    }
  });
});
