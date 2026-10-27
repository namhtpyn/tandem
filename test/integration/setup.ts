// unit-project setup: every test starts from a clean database. The schema and
// its migrations were applied ONCE in global-setup; truncating rows between
// tests keeps every file order-independent without re-running DDL. Files that
// deliberately test migration/boot behavior corrupt the ledger — the
// beforeAll/afterAll invariant check re-establishes it at file boundaries.
import { afterAll, beforeAll, beforeEach } from 'vitest';

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
