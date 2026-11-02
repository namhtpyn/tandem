// REST read-tier gate: the pure halves of the kernel's session middleware
// (requireSession + assertNotRotationLocked, SPEC "Boot seed law"). REST GET
// routes resolve the session then hand it here — anonymous -> 401,
// rotation-locked -> 403 before anything else, ANY role passes (reads are
// session-tier; the write twin with the role check lives in
// attachment-upload.ts gateWriteSession).
export type GateReadSessionLike = { user: { mustChangePassword?: boolean } };

export type ReadGateResult<S> = { ok: true; session: S } | { ok: false; statusCode: number; statusMessage: string };

/** REST twin of the kernel's session tier: anonymous -> 401, rotation-locked
 *  -> 403 `password change required` (before any data read), every role passes.
 *  The ok branch carries the narrowed session. */
export function gateReadSession<S extends GateReadSessionLike | null>(session: S): ReadGateResult<NonNullable<S>> {
  if (!session) return { ok: false, statusCode: 401, statusMessage: 'unauthorized' };
  if (session.user.mustChangePassword) return { ok: false, statusCode: 403, statusMessage: 'password change required' };
  return { ok: true, session: session as NonNullable<S> };
}
