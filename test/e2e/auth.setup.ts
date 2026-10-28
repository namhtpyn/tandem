import { rmSync } from 'node:fs';

import { test as setup } from '@playwright/test';

import { ADMIN_STATE } from './helpers/auth-state.ts';
import { login } from './helpers/login.ts';

setup('authenticate as admin', async ({ page }) => {
  // stale state from an older run would silently auth the suite with a dead
  // session — always start from nothing
  rmSync(ADMIN_STATE, { force: true });
  // same hydration-safe UI login as the specs; storageState capture replaces
  // the cookie path that dragged native SQL bindings into the worker
  await login(page);
  await page.context().storageState({ path: ADMIN_STATE });
});
