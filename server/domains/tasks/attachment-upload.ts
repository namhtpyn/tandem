// REST upload gate (audit #173): POST /api/tasks/:id/attachments is a WRITE —
// session presence alone wired it below its tier. These are the pure halves of
// the gate (the route maps UploadRejection -> h3 createError); they mirror the
// kernel laws exactly: requireRole (SPEC "Roles & access") and
// assertNotRotationLocked (SPEC "Boot seed law").
import { ROLE } from '#shared/enums';

import { ATTACHMENT_MAX_BYTES } from './attachments.util';

/** multipart framing (boundaries, field headers) allowed on top of the file cap */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** request-body cap enforced BEFORE multipart parsing — readMultipartFormData
 *  buffers the whole body, so checking the file part afterwards is too late */
export const ATTACHMENT_UPLOAD_BODY_MAX_BYTES = ATTACHMENT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

/** declared bodies up to this size are drained (so the client actually receives
 *  its 413) before rejection; past it the response races the upload and a reset
 *  earns nothing — no unbounded buffering for a declared-huge body */
export const DRAIN_CEILING_BYTES = 32 * 1024 * 1024;

/** input attachments a single task accepts (kind='input' rows) */
export const ATTACHMENT_PER_TASK_MAX = 20;

export class UploadRejection extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type GateUser = { role: string; mustChangePassword?: boolean };
type GateSessionLike = { user: GateUser };

export type GateResult<S> = { ok: true; session: S } | { ok: false; statusCode: number; statusMessage: string };

/** REST twin of employeeProcedure: anonymous -> 401, rotation-locked -> 403
 *  (before the role check, same as the kernel), VIEWER -> 403, EMPLOYEE/ADMIN
 *  pass. The ok branch carries the narrowed session. */
export function gateWriteSession<S extends GateSessionLike | null>(session: S): GateResult<NonNullable<S>> {
  if (!session) return { ok: false, statusCode: 401, statusMessage: 'unauthorized' };
  if (session.user.mustChangePassword) return { ok: false, statusCode: 403, statusMessage: 'password change required' };
  if (session.user.role !== ROLE.EMPLOYEE && session.user.role !== ROLE.ADMIN)
    return { ok: false, statusCode: 403, statusMessage: 'insufficient role' };
  return { ok: true, session: session as NonNullable<S> };
}

/** cheap pre-read rejection: a DECLARED body over the cap is refused before a
 *  single byte is buffered */
export function assertContentLength(contentLength: string | undefined | null): void {
  const n = Number(contentLength ?? 0);
  if (n > ATTACHMENT_UPLOAD_BODY_MAX_BYTES) throw new UploadRejection(413, 'attachment too large (20MB max)');
}

/** whether a declared-oversize body should be drained before the 413 (so the
 *  client sees the status instead of a reset) */
export function shouldDrainBeforeReject(contentLength: string | undefined | null): boolean {
  const n = Number(contentLength ?? 0);
  return n > ATTACHMENT_UPLOAD_BODY_MAX_BYTES && n <= DRAIN_CEILING_BYTES;
}

/** backstop for the cap on the BUFFERED body (covers chunked uploads whose
 *  size is unknown until fully received) — enforced before any parsing */
export function assertBodyBytes(raw: Buffer | undefined | null): void {
  if (raw && raw.byteLength > ATTACHMENT_UPLOAD_BODY_MAX_BYTES)
    throw new UploadRejection(413, 'attachment too large (20MB max)');
}

/** per-task input quota (audit #173): a task accepts a bounded number of
 *  uploads; callers count kind='input' rows and pass the total */
export function assertPerTaskQuota(existingInputCount: number): void {
  if (existingInputCount >= ATTACHMENT_PER_TASK_MAX)
    throw new UploadRejection(409, `attachment quota reached (${ATTACHMENT_PER_TASK_MAX} input files per task)`);
}
