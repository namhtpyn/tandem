import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest worker setup (ALL projects): test-only env defaults that pure code
// requires. The DB URL is intentionally NOT asserted here — the unit project
// must run without Postgres (no DB contract; server behavior is verified by
// the e2e suite against the real built server).
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod';
// vault key is REQUIRED in app code — deterministic test key (encrypt/decrypt in-run only)
process.env.TANDEM_VAULT_KEY = process.env.TANDEM_VAULT_KEY || Buffer.alloc(32, 7).toString('base64');
// attachment bytes go to a per-run directory under the process scratch dir (the
// runner points TMPDIR there) — never the /tandem/** production default, and never
// the system temp dir. The worker removes it on exit; a killed run leaves at most
// one directory behind for the scratch pruner.
if (!process.env.TANDEM_ATTACHMENTS_DIR) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tandem-att-'));
  process.env.TANDEM_ATTACHMENTS_DIR = dir;
  process.on('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
}
