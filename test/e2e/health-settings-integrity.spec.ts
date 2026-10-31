import { expect, test } from '@playwright/test';
// E2E: the live settings-corruption detector (SPEC: Health — settings
// integrity is part of readiness). Corrupting a KNOWN settings key's stored
// value 503s /health/ready with the generic body; repairing the row restores
// 200. The e2e db is truncated by the global setup, so a pre-existing
// run_timeout_ms row is restored (or re-deleted) in the cleanup.
import { SQL } from 'bun';

import { E2E_DATABASE_URL } from './helpers/env';

const KEY = 'run_timeout_ms';

test('corrupt known settings key degrades readiness until repaired', async ({ request }) => {
  const sql = new SQL(E2E_DATABASE_URL);
  try {
    const prev = await sql`SELECT value FROM settings WHERE key = ${KEY}`;
    const prevValue = prev.length > 0 ? (prev[0]!.value as string) : null;
    try {
      await sql`INSERT INTO settings (key, value, updated_at) VALUES (${KEY}, 'not-a-number', now())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      const bad = await request.get('/health/ready');
      expect(bad.status()).toBe(503);
      expect(await bad.json()).toEqual({ ok: false });

      await sql`DELETE FROM settings WHERE key = ${KEY}`;
      const good = await request.get('/health/ready');
      expect(good.status()).toBe(200);
      expect(await good.json()).toEqual({ ok: true, migrations: 'complete' });
    } finally {
      // restore the pre-test row state exactly
      if (prevValue === null) await sql`DELETE FROM settings WHERE key = ${KEY}`;
      else await sql`UPDATE settings SET value = ${prevValue}, updated_at = now() WHERE key = ${KEY}`;
    }
  } finally {
    await sql.end();
  }
});
