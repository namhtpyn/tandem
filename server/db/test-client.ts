// A raw postgres client that does NOT trigger the module-level DATABASE_URL
// guard in server/db/index.ts — test files import the app modules lazily after
// setting env, this one is safe to import first.
import postgresDriver from 'postgres'

const url = process.env.TANDEM_TEST_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_test'

export const postgres = postgresDriver(url, {
  max: 5,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
})

export { postgresDriver }
