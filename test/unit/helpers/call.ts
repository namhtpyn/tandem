// Unit seam for router procedures (#148): invoke a protectedProcedure with a
// valid session context and no HTTP — the context shape mirrors what the oRPC
// handler assembles per request (reqHeaders + getSession, per humanProcedure
// authz tests). Returns the raw call promise so tests can pin BOTH the value
// shape and the error contract (rejects.toMatchObject({ code })).
import { createProcedureClient } from '@orpc/server';

import { ROLE } from '#shared/enums';

const session = {
  sessionId: 'unit-session-row',
  user: { id: 'u1', name: 'Unit', email: 'unit@tandem.local', role: ROLE.EMPLOYEE },
} as const;

export function call<P extends object>(procedure: P, input: unknown): Promise<unknown> {
  // oRPC beta: the (initial) context rides the client options, not the call
  return createProcedureClient(
    procedure as never,
    {
      context: { reqHeaders: undefined, getSession: async () => session },
    } as never,
  )(input) as Promise<unknown>;
}
