// A raw postgres client that does NOT trigger the module-level DATABASE_URL
// guard in server/db/index.ts — test files import the app modules lazily after
// setting env, this one is safe to import first.
const url = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test';

export const postgres = new Bun.SQL(url, {
  max: 5,
  idleTimeout: 5,
  connectionTimeout: 10,
});
