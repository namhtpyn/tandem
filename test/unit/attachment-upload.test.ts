// Attachment upload gate (audit #173): pure halves of the REST write-tier gate —
// role matrix, rotation lock, pre-parse body cap, per-task input quota.
import { describe, expect, it } from 'vitest';

import {
  assertBodyBytes,
  assertContentLength,
  assertPerTaskQuota,
  ATTACHMENT_PER_TASK_MAX,
  ATTACHMENT_UPLOAD_BODY_MAX_BYTES,
  DRAIN_CEILING_BYTES,
  gateWriteSession,
  shouldDrainBeforeReject,
  UploadRejection,
} from '#server/domains/tasks/attachment-upload';
import { ATTACHMENT_MAX_BYTES } from '#server/domains/tasks/attachments.util';
import { ROLE } from '#shared/enums';

function sessionFor(role: string, mustChangePassword = false) {
  return { user: { id: 'u1', name: 'T', email: 't@x.io', role, mustChangePassword } };
}

describe('gateWriteSession — REST twin of employeeProcedure', () => {
  it('anonymous -> 401', () => {
    expect(gateWriteSession(null)).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('VIEWER -> 403 (session presence was the defect)', () => {
    expect(gateWriteSession(sessionFor(ROLE.VIEWER))).toMatchObject({ ok: false, statusCode: 403 });
  });

  it('rotation-locked session is refused before the role check (kernel law)', () => {
    for (const role of [ROLE.ADMIN, ROLE.EMPLOYEE]) {
      const r = gateWriteSession(sessionFor(role, true));
      expect(r).toMatchObject({ ok: false, statusCode: 403, statusMessage: 'password change required' });
    }
  });

  it('EMPLOYEE and ADMIN pass, session narrowed on ok', () => {
    for (const role of [ROLE.EMPLOYEE, ROLE.ADMIN]) {
      const r = gateWriteSession(sessionFor(role));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.session.user.role).toBe(role);
    }
  });
});

describe('body cap — enforced BEFORE multipart parsing', () => {
  it('declared length under the cap passes', () => {
    expect(() => assertContentLength(String(ATTACHMENT_UPLOAD_BODY_MAX_BYTES))).not.toThrow();
  });

  it('declared length over the cap -> 413 before any byte is buffered', () => {
    try {
      assertContentLength(String(ATTACHMENT_UPLOAD_BODY_MAX_BYTES + 1));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UploadRejection);
      expect((err as UploadRejection).statusCode).toBe(413);
    }
  });

  it('missing header (chunked) is not rejected — the buffered check owns it', () => {
    expect(() => assertContentLength(undefined)).not.toThrow();
  });

  it('buffered body over the cap -> 413 pre-parse', () => {
    const big = Buffer.alloc(ATTACHMENT_UPLOAD_BODY_MAX_BYTES + 1, 0x41);
    try {
      assertBodyBytes(big);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UploadRejection);
      expect((err as UploadRejection).statusCode).toBe(413);
    }
  });

  it('empty/undefined buffered body passes', () => {
    expect(() => assertBodyBytes(undefined)).not.toThrow();
    expect(() => assertBodyBytes(Buffer.alloc(0))).not.toThrow();
  });

  it('cap sits above the file cap (multipart overhead allowance)', () => {
    expect(ATTACHMENT_UPLOAD_BODY_MAX_BYTES).toBeGreaterThan(ATTACHMENT_MAX_BYTES);
  });

  it('declared-oversize within the drain ceiling is drained so the 413 lands', () => {
    expect(shouldDrainBeforeReject(String(ATTACHMENT_UPLOAD_BODY_MAX_BYTES + 1))).toBe(true);
    expect(shouldDrainBeforeReject(String(DRAIN_CEILING_BYTES))).toBe(true);
    // past the ceiling: no drain, the reset is earned
    expect(shouldDrainBeforeReject(String(DRAIN_CEILING_BYTES + 1))).toBe(false);
    expect(shouldDrainBeforeReject(undefined)).toBe(false);
  });
});

describe('assertPerTaskQuota — bounded input uploads per task', () => {
  it('under the quota passes', () => {
    expect(() => assertPerTaskQuota(ATTACHMENT_PER_TASK_MAX - 1)).not.toThrow();
  });

  it('at the quota -> 409', () => {
    try {
      assertPerTaskQuota(ATTACHMENT_PER_TASK_MAX);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UploadRejection);
      expect((err as UploadRejection).statusCode).toBe(409);
    }
  });
});
