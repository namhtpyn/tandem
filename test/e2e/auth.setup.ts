import { rmSync } from 'node:fs';

import { test as setup } from '@playwright/test';

import { login } from './helpers/login.ts';

// Consumed by the chromium project's use.storageState (playwright.config.ts) —
// keep the two literals in sync.
const ADMIN_STATE = 'test/e2e/.auth/admin.json';

setup('authenticate as admin', async ({ page }) => {
  // stale state from an older run would silently auth the suite with a dead
  // session — always start from nothing
  rmSync(ADMIN_STATE, { force: true });
  // same hydration-safe UI login as the specs; storageState capture replaces
  // the cookie path that dragged native SQL bindings into the worker
  await login(page);
  await page.context().storageState({ path: ADMIN_STATE });
});
