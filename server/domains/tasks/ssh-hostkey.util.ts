// SSH host-key verification seam (SPEC: Environments procedures — host-key law).
// Every ssh2 transport (exec, file shuttle, ACP-over-SSH) passes a hostVerifier
// built here: the presented wire-format host key is fingerprinted
// 'sha256:<base64 nopad>' and compared against the environment's TOFU store.
// First contact accepts + persists; a stored-fingerprint mismatch fails CLOSED
// (the connection dies before auth — the SSH credential and the env blob's API
// key never reach an impostor). DB-free by design: trust state rides the plan,
// so tests drive the whole seam without a database.
import { createHash } from 'node:crypto';

import { consola } from 'consola';

/** plan fields carrying host-key trust state; every SSH transport's plan type intersects this */
export type HostKeyTrust = {
  /** environments row id — names the TOFU store entry in logs */
  envId?: string;
  /** stored fingerprint; null/undefined = first contact (TOFU) */
  knownHostFingerprint?: string | null;
  /** persist the fingerprint on first contact; absent = ephemeral accept-new */
  saveHostFingerprint?: (fingerprint: string) => Promise<void>;
};

/** OpenSSH-style fingerprint of the wire-format host key blob */
export function hostKeyFingerprint(key: Buffer | string): string {
  return `sha256:${createHash('sha256').update(key).digest('base64').replaceAll('=', '')}`;
}

/**
 * TOFU decision: true = the presented key matches trust (stored match, or
 * first contact after persisting). false = stored mismatch — HARD STOP.
 * Never throws (a persist failure degrades to per-connection accept-new;
 * the mismatch guard is unaffected either way).
 */
export async function verifyHostKey(trust: HostKeyTrust, key: Buffer | string): Promise<boolean> {
  const fingerprint = hostKeyFingerprint(key);
  if (trust.knownHostFingerprint) {
    if (trust.knownHostFingerprint === fingerprint) return true;
    consola.error(
      `[ssh-hostkey] HOST KEY MISMATCH env=${trust.envId ?? 'unknown'} stored=${trust.knownHostFingerprint} presented=${fingerprint} — connection refused`,
    );
    return false;
  }
  if (trust.saveHostFingerprint) {
    try {
      await trust.saveHostFingerprint(fingerprint);
    } catch (e) {
      consola.warn(
        `[ssh-hostkey] first-contact persist failed env=${trust.envId ?? 'unknown'}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return true;
}

/**
 * ssh2 hostVerifier adapter. Contract (ssh2 client.js): the callback RECEIVES
 * (key: Buffer, verify: (valid: boolean) => void) and MUST call verify() —
 * a RETURNED value is passed to verify verbatim, so returning a Promise would
 * count as truthy and silently accept. We bridge the async decision through
 * the callback and return undefined.
 */
export function sshHostVerifier(trust: HostKeyTrust) {
  return (key: Buffer, verify: (valid: boolean) => void): void => {
    void verifyHostKey(trust, key).then(
      (ok) => verify(ok),
      () => verify(false),
    );
  };
}
