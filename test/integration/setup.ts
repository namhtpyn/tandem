// integration-project setup: DB env contract + a clean database per test. The
// schema was applied ONCE in global-setup (or the CI service DB was migrated);
// truncating rows between tests keeps every file order-independent without
// re-running DDL. Files that deliberately test migration/boot behavior corrupt
// the ledger — the beforeAll/afterAll invariant check re-establishes it at file
// boundaries.
import { afterAll, beforeAll, beforeEach } from 'vitest';

if (!process.env.TANDEM_TEST_DATABASE_URL) {
  throw new Error('TANDEM_TEST_DATABASE_URL missing — global-setup did not provide a database');
}
process.env.DATABASE_URL = process.env.TANDEM_TEST_DATABASE_URL;

beforeAll(async () => {
  const { ensureMigrated } = await import('./helpers/pg');
  await ensureMigrated();
});

beforeEach(async () => {
  const { resetData } = await import('./helpers/pg');
  await resetData();
});

afterAll(async () => {
  const { ensureMigrated } = await import('./helpers/pg');
  await ensureMigrated();
});
