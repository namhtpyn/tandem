// REST read-tier gate (audit #242): session-tier matrix for the GET file
// routes — anonymous, rotation lock, any-role pass. The write twin's matrix
// (role check included) is pinned in attachment-upload.test.ts.
import { describe, expect, it } from 'vitest';

import { gateReadSession } from '#server/domains/kernel/rest-gates';
import { ROLE } from '#shared/enums';

function sessionFor(role: string, mustChangePassword = false) {
  return { user: { id: 'u1', name: 'T', email: 't@x.io', role, mustChangePassword } };
}

describe('gateReadSession — REST twin of the kernel session tier', () => {
  it('anonymous -> 401', () => {
    expect(gateReadSession(null)).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('rotation-locked session -> 403 `password change required` at every role', () => {
    for (const role of [ROLE.VIEWER, ROLE.EMPLOYEE, ROLE.ADMIN]) {
      const r = gateReadSession(sessionFor(role, true));
      expect(r).toMatchObject({ ok: false, statusCode: 403, statusMessage: 'password change required' });
    }
  });

  it('unlocked sessions pass at every role (reads are session-tier), session narrowed on ok', () => {
    for (const role of [ROLE.VIEWER, ROLE.EMPLOYEE, ROLE.ADMIN]) {
      const r = gateReadSession(sessionFor(role));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.session.user.role).toBe(role);
    }
  });
});
