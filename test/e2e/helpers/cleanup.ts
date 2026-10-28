import { test as base, expect } from '@playwright/test';
import { SQL } from 'bun';

import { E2E_DATABASE_URL } from './env';
// Per-test teardown: every row this test created is deleted afterwards, even
// when an assertion failed before the spec's inline UI cleanup ran. The window
// is [fixture setup, fixture teardown) on the same host clock as the app, so
// rows from earlier tests (or the boot admin) are never touched.
//
// Tasks go FIRST: their children (messages/runs/obligations/attachments…) cascade
// from tasks.id, and deleting the assignee user first would only null the
// reference (tasks.assignee_id is ON DELETE SET NULL), leaving orphan tasks.
const SWEEP = [
  'delete from tasks where created_at >= $1',
  // users before environments: ai_employees cascade from "user" but their
  // environment_id is ON DELETE RESTRICT, so the agent rows must go first
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
      const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
      const failures: string[] = [];
      try {
        for (const statement of SWEEP) {
          try {
            await sql.unsafe(statement, [startedAt]);
          } catch (e) {
            // collect + throw at the end: a swallowed cleanup error leaks rows
            // into every later spec and turns one failure into a cascade
            failures.push(`${statement}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        await sql.close();
      }
      if (failures.length) throw new Error(`e2e cleanup failed:\n${failures.join('\n')}`);
    },
    { auto: true },
  ],
});

export { expect };
