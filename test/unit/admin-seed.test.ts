import { beforeEach, describe, expect, it, vi } from 'vitest';

// BOOT SEED LAW (SPEC, #172): no default admin credential. Seeding requires an
// explicit ADMIN_PASSWORD, refuses the known literal, and marks the seeded
// admin for forced first-login rotation. no-real-DB unit law: the db module is
// mocked; crypto (hashPassword) runs for real — it is pure.

type UserRow = Record<string, unknown>;
let existingUsers: { id: string }[];
let insertedUsers: UserRow[];
let insertedAccounts: UserRow[];

vi.mock('../../server/db/index', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      query: {
        user: {
          findFirst: async () => existingUsers[0],
        },
      },
      insert: (table: object) => ({
        values: async (row: UserRow) => {
          if (getTableName(table as never) === 'user') insertedUsers.push(row);
          else insertedAccounts.push(row);
        },
      }),
    },
  };
});

import { setEnv } from '#server/domains/kernel/env';

import {
  AdminSeedError,
  KNOWN_DEFAULT_ADMIN_PASSWORD,
  resolveSeedCredential,
  seedAdminIfEmpty,
} from '../../server/domains/auth/admin-seed.service';

beforeEach(() => {
  existingUsers = [];
  insertedUsers = [];
  insertedAccounts = [];
  setEnv({ ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined, TANDEM_SEED_NO_ROTATION: undefined });
});

describe('resolveSeedCredential (seed policy)', () => {
  it('missing ADMIN_PASSWORD is refused — no default credential exists', () => {
    expect(() => resolveSeedCredential({ ADMIN_PASSWORD: undefined })).toThrow(AdminSeedError);
    try {
      resolveSeedCredential({});
    } catch (e) {
      expect((e as AdminSeedError).issues).toEqual([
        { path: ['ADMIN_PASSWORD'], message: expect.stringContaining('is required to seed the first admin') },
      ]);
    }
  });

  it(`the known default "${KNOWN_DEFAULT_ADMIN_PASSWORD}" is refused as a seed value`, () => {
    expect(() => resolveSeedCredential({ ADMIN_PASSWORD: KNOWN_DEFAULT_ADMIN_PASSWORD })).toThrow(
      /must not be the known default/,
    );
  });

  it('a real password seeds with the default email', () => {
    expect(resolveSeedCredential({ ADMIN_PASSWORD: 'correct-horse-battery' })).toEqual({
      email: 'admin@tandem.local',
      password: 'correct-horse-battery',
    });
  });

  it('ADMIN_EMAIL override is honored', () => {
    expect(resolveSeedCredential({ ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'correct-horse-battery' })).toEqual(
      {
        email: 'root@example.com',
        password: 'correct-horse-battery',
      },
    );
  });
});

describe('seedAdminIfEmpty', () => {
  it('no-op when any user exists — restarts never touch real accounts', async () => {
    existingUsers = [{ id: 'u1' }];
    await expect(seedAdminIfEmpty()).resolves.toBeNull();
    expect(insertedUsers).toHaveLength(0);
    expect(insertedAccounts).toHaveLength(0);
  });

  it('seeds the admin with role ADMIN and the ROTATION FLAG set', async () => {
    setEnv({ ADMIN_PASSWORD: 'correct-horse-battery' });
    const seeded = await seedAdminIfEmpty();
    expect(seeded).toEqual({ email: 'admin@tandem.local' });
    expect(insertedUsers).toHaveLength(1);
    expect(insertedUsers[0]).toMatchObject({ role: 'ADMIN', emailVerified: true, mustChangePassword: true });
    expect(insertedAccounts).toHaveLength(1);
    expect(insertedAccounts[0]).toMatchObject({ providerId: 'credential' });
  });

  it('TANDEM_SEED_NO_ROTATION=true is the only way to seed without the flag (test knob)', async () => {
    setEnv({ ADMIN_PASSWORD: 'correct-horse-battery', TANDEM_SEED_NO_ROTATION: 'true' });
    await seedAdminIfEmpty();
    expect(insertedUsers[0]).toMatchObject({ mustChangePassword: false });
  });
});
