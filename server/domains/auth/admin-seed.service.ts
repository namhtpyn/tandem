// Boot seed policy (SPEC "Boot seed law", #172): there is NO default admin
// credential. Seeding requires an explicit ADMIN_PASSWORD, refuses the known
// literal default, and marks the seeded admin for forced first-login rotation.
// Pure policy + DB writes live here; boot.ts only catches AdminSeedError and
// routes it through the shared env-failure report.
import { v7 as uuidv7 } from 'uuid';

import { ROLE } from '#shared/enums';

import { db } from '../../db/index';
import { account, user } from '../../db/schema';
import { env } from '../kernel/env';
import type { EnvIssue } from '../kernel/env';
import { hashPassword } from './auth-hash.util';

/** the credential every historical deployment shipped with — refused as a seed value */
export const KNOWN_DEFAULT_ADMIN_PASSWORD = 'tandem-admin';

const DEFAULT_ADMIN_EMAIL = 'admin@tandem.local';

/** failed seed policy → boot exits with the env-failure report (test-assertable, no exit mocking) */
export class AdminSeedError extends Error {
  public constructor(public readonly issues: EnvIssue[]) {
    super(issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    this.name = 'AdminSeedError';
  }
}
export type SeedCredential = { email: string; password: string };

/** resolve the credential a fresh instance will seed — throws AdminSeedError on any violation */
export function resolveSeedCredential(e: Pick<typeof env, 'ADMIN_EMAIL' | 'ADMIN_PASSWORD'>): SeedCredential {
  const issues: EnvIssue[] = [];
  if (!e.ADMIN_PASSWORD) {
    issues.push({
      path: ['ADMIN_PASSWORD'],
      message: 'is required to seed the first admin — no default credential exists',
    });
  } else if (e.ADMIN_PASSWORD === KNOWN_DEFAULT_ADMIN_PASSWORD) {
    issues.push({
      path: ['ADMIN_PASSWORD'],
      message: `must not be the known default "${KNOWN_DEFAULT_ADMIN_PASSWORD}" — set a real password`,
    });
  }
  if (issues.length > 0) throw new AdminSeedError(issues);
  return { email: e.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL, password: e.ADMIN_PASSWORD as string };
}

/** seed the first admin when the instance has NO users; no-op when any account exists */
export async function seedAdminIfEmpty(): Promise<{ email: string } | null> {
  const existing = await db.query.user.findFirst({ columns: { id: true } });
  if (existing) return null;

  const { email, password } = resolveSeedCredential(env);
  const id = uuidv7();
  const now = new Date();
  await db.insert(user).values({
    id,
    name: 'Admin',
    email,
    emailVerified: true,
    mustChangePassword: env.TANDEM_SEED_NO_ROTATION !== 'true',
    createdAt: now,
    updatedAt: now,
    role: ROLE.ADMIN,
  });
  // password hash via better-auth's own hasher for compatibility
  await db.insert(account).values({
    id: uuidv7(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  return { email };
}
