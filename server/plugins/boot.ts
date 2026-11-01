import { consola } from 'consola';
import { v7 as uuidv7 } from 'uuid';

import { ROLE } from '#shared/enums';

export const log = consola.withTag('tandem');

import { env } from '#server/domains/kernel/env';

// Boot: apply migrations, then seed the default admin when the instance has NO
// users. A brand-new deployment therefore always has a known login:
//   email    = env ADMIN_EMAIL    (default admin@tandem.local)
//   password = env ADMIN_PASSWORD (default tandem-admin)
// Skipped when any user row exists — restarts never overwrite real accounts.
import { db } from '../db/index';
import { applyMigrations } from '../db/index';
import { user, account } from '../db/schema';

export default defineNitroPlugin(async () => {
  const applied = await applyMigrations();
  if (applied.length > 0) log.info('applied migrations:', applied.join(', '));

  // settings integrity audit (SPEC: Health) — log-only at boot; /health/ready
  // 503s while any known key is corrupt. The detector never breaks boot.
  try {
    const { auditSettingsIntegrity } = await import('../domains/settings/settings.integrity');
    const integrity = await auditSettingsIntegrity();
    if (integrity.ok) log.info('settings integrity: ok');
    else
      log.error(
        'settings corrupt (readiness will report not-ready):',
        integrity.corrupt.map((c) => `${c.key} (${c.reason})`).join(', '),
      );
  } catch (e) {
    log.error('settings integrity audit failed:', e);
  }

  // agent dispatcher: eligible tasks (ready + AI assignee) fire automatically.
  // Opt out with TANDEM_NO_DISPATCHER=1 (tests); fake runner with TANDEM_FAKE_RUNNER=1.
  // REAPER LIVENESS (#147): a bare await here meant a redis blip at restart left
  // the server serving with NO dispatcher and NO reaper — the start now retries
  // on a fixed machine interval and logs every failed attempt loudly.
  const { maybeStartDispatcher, ensureDispatcherRunning } = await import('../domains/tasks/dispatcher.service');
  ensureDispatcherRunning({ start: maybeStartDispatcher });
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
  log.info(`seeded admin ${email} (change the password after first login)`);
});
