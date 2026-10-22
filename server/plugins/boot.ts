import { consola } from 'consola';
import { v7 as uuidv7 } from 'uuid';

import { ROLE } from '#shared/enums';

// Boot: apply migrations, then seed the default admin when the instance has NO
// users. A brand-new deployment therefore always has a known login:
//   email    = env ADMIN_EMAIL    (default admin@tandem.local)
//   password = env ADMIN_PASSWORD (default tandem-admin)
// Skipped when any user row exists — restarts never overwrite real accounts.
import { db } from '../db';
import { applyMigrations } from '../db';
import { user, account } from '../db/schema';
import { env } from '../domains/kernel/env';

export default defineNitroPlugin(async () => {
  const applied = await applyMigrations();
  if (applied.length > 0) consola.withTag('tandem').info('applied migrations:', applied.join(', '));

  // agent dispatcher: eligible tasks (ready + AI assignee) fire automatically.
  // Opt out with TANDEM_NO_DISPATCHER=1 (tests); fake runner with TANDEM_FAKE_RUNNER=1.
  const { maybeStartDispatcher } = await import('../domains/tasks/dispatcher.service');
  await maybeStartDispatcher();
  const { bridgeRedisChanges } = await import('../domains/kernel/change-bus');
  await bridgeRedisChanges();

  const existing = await db.query.user.findFirst({ columns: { id: true } });
  if (existing) return;

  const email = env.ADMIN_EMAIL ?? 'admin@tandem.local';
  const password = env.ADMIN_PASSWORD ?? 'tandem-admin';
  const id = uuidv7();
  const now = new Date();
  await db.insert(user).values({
    id,
    name: 'Admin',
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    role: ROLE.ADMIN,
  });
  // password hash via better-auth's own hasher for compatibility
  const { hashPassword } = await import('../domains/auth/auth-hash.util');
  await db.insert(account).values({
    id: uuidv7(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  consola.withTag('tandem').info(`seeded admin ${email} (change the password after first login)`);
});
