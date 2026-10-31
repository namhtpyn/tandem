// GET /health/ready — readiness: 200 only when Postgres answers SELECT 1 AND
// all migrations are applied. 503 otherwise (pull out of rotation, no restart).
import { consola } from 'consola';
import { defineEventHandler, setResponseStatus } from 'h3';

export const log = consola.withTag('tandem');

import { sqlClient } from '../../db/index';
import { applyMigrations } from '../../db/index';

let migrationsDone = false;

export default defineEventHandler(async (event) => {
  try {
    await sqlClient`select 1`;
    if (!migrationsDone) {
      const applied = await applyMigrations();
      if (applied.length > 0) log.info('applied migrations:', applied.join(', '));
      migrationsDone = true;
    }
    // settings integrity (SPEC: Health) — a corrupt KNOWN key degrades
    // readiness: this is the live detector for the fail-closed read path.
    const { auditSettingsIntegrity } = await import('../../domains/settings/settings.integrity');
    const integrity = await auditSettingsIntegrity();
    if (!integrity.ok) {
      // details go to the logs only — the body stays generic for the
      // unauthenticated probe
      log.error('readiness: corrupt settings —', integrity.corrupt.map((c) => `${c.key} (${c.reason})`).join(', '));
      setResponseStatus(event, 503);
      return { ok: false };
    }
    setResponseStatus(event, 200);
    return { ok: true, migrations: 'complete' };
  } catch (e) {
    // the body stays generic — driver text must never reach an unauthenticated probe
    log.error('readiness check failed:', e);
    setResponseStatus(event, 503);
    return { ok: false };
  }
});
