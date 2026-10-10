// vitest worker setup: the suite-scoped Postgres URL is injected by
// tests/global-setup.ts (own container locally; CI service container via env).
if (!process.env.TANDEM_TEST_DATABASE_URL) {
  throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not run')
}
process.env.DATABASE_URL = process.env.TANDEM_TEST_DATABASE_URL
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod'
