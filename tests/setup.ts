// vitest worker setup: the suite-scoped Postgres URL is injected by
// tests/global-setup.ts (own container locally; CI service container via env).
if (!process.env.TANDEM_TEST_DATABASE_URL) {
  throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not run')
}
process.env.DATABASE_URL = process.env.TANDEM_TEST_DATABASE_URL
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod'
// vault key is REQUIRED in app code — deterministic test key (encrypt/decrypt in-run only)
process.env.TANDEM_VAULT_KEY = process.env.TANDEM_VAULT_KEY || Buffer.alloc(32, 7).toString('base64')
// attachment bytes go to a per-run tmp dir — never the /tandem/** production default
process.env.TANDEM_ATTACHMENTS_DIR = process.env.TANDEM_ATTACHMENTS_DIR
  || (() => { const { mkdtempSync } = require('node:fs') as typeof import('node:fs'); const { tmpdir } = require('node:os') as typeof import('node:os'); const { join } = require('node:path') as typeof import('node:path'); return mkdtempSync(join(tmpdir(), 'tandem-att-')) })()
