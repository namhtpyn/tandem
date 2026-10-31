import { createProcedureClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

// HUMAN-only verdict gate (SPEC "Roles & access"): approve/requestChanges/
// reject reject sessions whose credential origin is an API key — better-auth's
// apiKey plugin fabricates the session for an x-api-key request with
// session.id = apiKey.id, so the origin is resolvable server-side (no-real-DB
// unit law: the apikey lookup is mocked; the lookup seam itself is one PK
// select covered by the middleware contract here).

const AGENT_KEY_ID = 'agent-api-key-row-id';
let apiKeyIds: string[] = [];

vi.mock('../../server/db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => apiKeyIds.map((id) => ({ id })),
        }),
      }),
    }),
  },
}));

import { ROLE } from '#shared/enums';

import { humanProcedure } from '../../server/domains/kernel/kernel';

function clientFor(getSession: () => Promise<unknown>) {
  // oRPC beta.44: the (initial) context rides the client options, not the call
  return createProcedureClient(
    humanProcedure.handler(async () => 'verdict-recorded') as never,
    { context: { reqHeaders: undefined, getSession } } as never,
  ) as (input?: unknown) => Promise<unknown>;
}

const user = (role: string) => ({ id: 'u1', name: 'Test', email: 't@x.io', role });

describe('humanProcedure (verdict credential-origin gate)', () => {
  it('human session (session-row id) on the right role is ALLOWED', async () => {
    apiKeyIds = [];
    const client = clientFor(async () => ({ sessionId: 'real-session-row-id', user: user(ROLE.EMPLOYEE) }));
    await expect(client()).resolves.toBe('verdict-recorded');
  });

  it('agent API-key session on EMPLOYEE is FORBIDDEN', async () => {
    apiKeyIds = [AGENT_KEY_ID];
    const client = clientFor(async () => ({ sessionId: AGENT_KEY_ID, user: user(ROLE.EMPLOYEE) }));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('agent API-key session on ADMIN is FORBIDDEN — role does not buy the verdict', async () => {
    apiKeyIds = [AGENT_KEY_ID];
    const client = clientFor(async () => ({ sessionId: AGENT_KEY_ID, user: user(ROLE.ADMIN) }));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('VIEWER human session stays role-FORBIDDEN', async () => {
    apiKeyIds = [];
    const client = clientFor(async () => ({ sessionId: 'real-session-row-id', user: user(ROLE.VIEWER) }));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('anonymous is UNAUTHORIZED (401 before 403)', async () => {
    apiKeyIds = [];
    const client = clientFor(async () => null);
    await expect(client()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a session with no resolvable id is treated as human (defensive)', async () => {
    apiKeyIds = [AGENT_KEY_ID];
    const client = clientFor(async () => ({ user: user(ROLE.EMPLOYEE) }));
    await expect(client()).resolves.toBe('verdict-recorded');
  });
});
