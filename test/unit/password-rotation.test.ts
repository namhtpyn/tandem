import { createProcedureClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

// ROTATION LOCK (SPEC "Boot seed law", #172): a session whose user owes the
// forced first-login password change reaches exactly ONE procedure —
// auth.changeMyPassword. Everything above the public tier refuses FORBIDDEN
// 'password change required' before any other check; changeMyPassword verifies
// the current credential, replaces it and clears the flag in ONE transaction.
// no-real-DB unit law: the db module is mocked; crypto runs for real.

let credentialRow: { id: string; password: string } | undefined;
let transactionOps: { table: string; patch: Record<string, unknown> }[];

vi.mock('../../server/db/index', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      query: {
        account: {
          findFirst: async () => credentialRow,
        },
      },
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          update: (table: object) => ({
            set: (patch: Record<string, unknown>) => ({
              where: async () => {
                transactionOps.push({ table: getTableName(table as never), patch });
              },
            }),
          }),
        };
        await fn(tx);
      },
    },
  };
});

import { ROLE } from '#shared/enums';

import { hashPassword } from '../../server/domains/auth/auth-hash.util';
import { changeMyPassword } from '../../server/domains/auth/auth.service';
import {
  employeeProcedure,
  humanProcedure,
  lockedSessionProcedure,
  protectedProcedure,
} from '../../server/domains/kernel/kernel';

type GateProcedure = typeof protectedProcedure;

function clientFor(procedure: GateProcedure, getSession: () => Promise<unknown>) {
  // oRPC beta.44: the (initial) context rides the client options, not the call
  return createProcedureClient(
    procedure.handler(async () => 'reached') as never,
    {
      context: { reqHeaders: undefined, getSession },
    } as never,
  ) as (input?: unknown) => Promise<unknown>;
}

const session = (mustChangePassword: boolean) => ({
  sessionId: 'real-session-row-id',
  user: { id: 'u1', name: 'Admin', email: 'a@x.io', role: ROLE.ADMIN, mustChangePassword },
});

describe('rotation lock (procedure tiers)', () => {
  it('protectedProcedure refuses a locked session FORBIDDEN before any handler runs', async () => {
    const client = clientFor(protectedProcedure, async () => session(true));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'password change required' });
  });

  it('an unlocked session passes protectedProcedure unchanged', async () => {
    const client = clientFor(protectedProcedure, async () => session(false));
    await expect(client()).resolves.toBe('reached');
  });

  it('employeeProcedure refuses a locked ADMIN — role does not buy the bypass', async () => {
    const client = clientFor(employeeProcedure, async () => session(true));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('humanProcedure refuses a locked session too', async () => {
    const client = clientFor(humanProcedure, async () => session(true));
    await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lockedSessionProcedure is the escape hatch — auth.changeMyPassword stays reachable', async () => {
    const client = clientFor(lockedSessionProcedure, async () => session(true));
    await expect(client()).resolves.toBe('reached');
  });

  it('an anonymous session is still UNAUTHORIZED (never FORBIDDEN) on every tier', async () => {
    for (const procedure of [protectedProcedure, employeeProcedure, humanProcedure, lockedSessionProcedure]) {
      const client = clientFor(procedure, async () => null);
      await expect(client()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});

describe('auth.changeMyPassword (the flag-clearing path)', () => {
  it('refuses a too-short new password before touching the db', async () => {
    transactionOps = [];
    await expect(changeMyPassword({ userId: 'u1', currentPassword: 'x', newPassword: 'short' })).resolves.toEqual({
      ok: false,
      reason: 'TOO_SHORT',
    });
    expect(transactionOps).toHaveLength(0);
  });

  it('NO_CREDENTIAL when the user has no password account (OIDC-only identity)', async () => {
    credentialRow = undefined;
    await expect(
      changeMyPassword({ userId: 'u1', currentPassword: 'x', newPassword: 'long-enough-pw' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'NO_CREDENTIAL',
    });
  });

  it('WRONG_PASSWORD when the current credential does not verify', async () => {
    credentialRow = { id: 'acc1', password: await hashPassword('the-real-current') };
    await expect(
      changeMyPassword({ userId: 'u1', currentPassword: 'wrong-guess', newPassword: 'long-enough-pw' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'WRONG_PASSWORD',
    });
  });

  it('success: new hash verifies, flag cleared — account + user updated in ONE transaction', async () => {
    credentialRow = { id: 'acc1', password: await hashPassword('the-real-current') };
    transactionOps = [];
    const result = await changeMyPassword({
      userId: 'u1',
      currentPassword: 'the-real-current',
      newPassword: 'brand-new-pw-1',
    });
    expect(result).toEqual({ ok: true });
    expect(transactionOps.map((op) => op.table)).toEqual(['account', 'user']);
    const accountPatch = transactionOps.find((op) => op.table === 'account')?.patch;
    const userPatch = transactionOps.find((op) => op.table === 'user')?.patch;
    // the stored hash IS the new password's hash — verifiable against it, not the old one
    const { verifyPassword } = await import('better-auth/crypto');
    expect(await verifyPassword({ hash: accountPatch?.password as string, password: 'brand-new-pw-1' })).toBe(true);
    expect(await verifyPassword({ hash: accountPatch?.password as string, password: 'the-real-current' })).toBe(false);
    expect(userPatch).toMatchObject({ mustChangePassword: false });
  });
});
