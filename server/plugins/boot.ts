import { consola } from 'consola';

export const log = consola.withTag('tandem');

import { reportInvalidEnvironment } from '#server/domains/kernel/env';

// Boot: apply migrations, then seed the default admin when the instance has NO
// users (SPEC "Boot seed law", #172): seeding REQUIRES an explicit ADMIN_PASSWORD
// — no default credential exists — and the seeded admin must rotate the password
// on first login. Policy lives in admin-seed.service; a violation exits here via
// the shared env-failure report. Skipped when any user row exists — restarts
// never overwrite real accounts.
import { db } from '../db/index';
import { applyMigrations } from '../db/index';

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

  const { AdminSeedError, seedAdminIfEmpty } = await import('../domains/auth/admin-seed.service');
  try {
    const seeded = await seedAdminIfEmpty();
    if (seeded) log.info(`seeded admin ${seeded.email} (password change required on first login)`);
  } catch (e) {
    if (e instanceof AdminSeedError) reportInvalidEnvironment(e.issues);
    throw e;
  }
});
