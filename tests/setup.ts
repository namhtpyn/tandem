// vitest setup: point the app's db module at the test database BEFORE import.
process.env.DATABASE_URL = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-not-for-prod'
