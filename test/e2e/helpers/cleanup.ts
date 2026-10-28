import { test as base, expect } from '@playwright/test';
import { SQL } from 'bun';

// Per-test teardown: every row this test created is deleted afterwards, even
// when an assertion failed before the spec's inline UI cleanup ran. The window
// is [fixture setup, fixture teardown) on the same host clock as the app, so
// rows from earlier tests (or the boot admin) are never touched.
const DATABASE_URL = process.env.TANDEM_E2E_DATABASE_URL ?? 'postgresql://tandem:***@127.0.0.1:55432/tandem_e2e';

// children first: users cascade to ai_employees/keys/supervisors; the rest
// null out their references (tasks.assignee, environments.secret)
const SWEEP = [
  'delete from "user" where created_at >= $1',
  'delete from projects where created_at >= $1',
  'delete from environments where created_at >= $1',
  'delete from vault_folders where created_at >= $1',
  'delete from vault_secrets where created_at >= $1',
  'delete from model_providers where created_at >= $1',
];

export const test = base.extend<{ dbCleanup: void }>({
  // auto fixture: no spec signature changes — importing `test` from here is enough
  dbCleanup: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures need a destructuring pattern
    async ({}, use) => {
      const startedAt = new Date();
      await use();
      const sql = new SQL(DATABASE_URL, { max: 1 });
      try {
        for (const statement of SWEEP) {
          await sql.unsafe(statement, [startedAt]).catch(() => undefined);
        }
      } finally {
        await sql.close();
      }
    },
    { auto: true },
  ],
});

export { expect };
