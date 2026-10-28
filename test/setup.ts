// vitest worker setup: the suite-scoped Postgres URL is injected by
// tests/global-setup.ts (own container locally; CI service container via env).
if (!process.env.TANDEM_TEST_DATABASE_URL) {
  throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not run');
}
process.env.DATABASE_URL = process.env.TANDEM_TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod';
// vault key is REQUIRED in app code — deterministic test key (encrypt/decrypt in-run only)
process.env.TANDEM_VAULT_KEY = process.env.TANDEM_VAULT_KEY || Buffer.alloc(32, 7).toString('base64');
// attachment bytes go to a per-run directory under the process scratch dir (the
// runner points TMPDIR there) — never the /tandem/** production default, and never
// the system temp dir. The worker removes it on exit; a killed run leaves at most
// one directory behind for the scratch pruner.
if (!process.env.TANDEM_ATTACHMENTS_DIR) {
  const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tandem-att-'));
  process.env.TANDEM_ATTACHMENTS_DIR = dir;
  process.on('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
}
