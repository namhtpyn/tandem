import { defineConfig, devices } from '@playwright/test';

import { ADMIN_STATE } from './test/e2e/helpers/auth-state.ts';
import { E2E_DATABASE_URL } from './test/e2e/helpers/env.ts';

export default defineConfig({
  // ONE worker, both locally and in CI: every spec shares the same e2e
  // database, so parallel workers only race truncates and login state (and at
  // 4+ they starved the app server into random login/fill timeouts). The
  // shared-DB serial promise is the config's contract — no worker env tuning.
  workers: 1,
  // a stray .only must not silently reduce CI to a fraction of the suite
  forbidOnly: !!process.env.CI,
  testDir: './test/e2e',
  // fresh data set per run: truncates app tables (keeps the boot admin + seeds)
  // AFTER Playwright has started the web server and migrations have applied
  globalSetup: './test/e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false, // shared DB — serial by file
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.TANDEM_E2E_URL || 'http://localhost:4100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // signs in once; chromium consumes the saved session cookie
    { name: 'setup', testMatch: '*.setup.ts' },
    {
      name: 'chromium',
      testIgnore: '*.setup.ts', // the setup file belongs to the setup project only
      use: { ...devices['Desktop Chrome'], storageState: ADMIN_STATE },
      dependencies: ['setup'], // the state file must exist before chromium starts
    },
  ],
  webServer: process.env.TANDEM_E2E_NO_SERVER
    ? undefined
    : {
        command: `PORT=4100 TANDEM_FAKE_RUNNER=1 REDIS_URL=${process.env.TANDEM_E2E_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6399'} TANDEM_PUBLIC_URL=http://localhost:4100 BETTER_AUTH_URL=http://localhost:4100 TANDEM_VAULT_KEY=${process.env.TANDEM_E2E_VAULT_KEY || Buffer.alloc(32, 7).toString('base64')} TANDEM_ATTACHMENTS_DIR=${process.env.TANDEM_E2E_ATTACHMENTS_DIR || '/tmp/tandem-e2e-attachments'} ADMIN_PASSWORD=${process.env.TANDEM_E2E_ADMIN_PASSWORD || 'tandem-e2e-seed-pw'} DATABASE_URL=${E2E_DATABASE_URL} bun .output/server/index.mjs`,
        env: {
          TANDEM_E2E_DATABASE_URL: E2E_DATABASE_URL,
          // #229: the fake script carries ::wait pauses so a dispatched run stays
          // RUNNING ~5s — a live window a human stop click can land inside. Every
          // other fake-run e2e just completes a few seconds later (same RESULT line).
          TANDEM_FAKE_SCRIPT: [
            'thinking about the task…',
            '::wait:2500',
            'reading context',
            '::wait:2500',
            'working: step 1/3',
            'working: step 2/3',
            'working: step 3/3',
            'RESULT: task complete as requested',
          ].join('\n'),
          // #276: the CORRECTED re-dispatch's script — used ONLY when the frozen
          // brief carries the verdict-less correction marker (fake-runner parity)
          TANDEM_FAKE_SCRIPT_REVIEW_CORRECTED: [
            're-verifying with the correction contract in mind…',
            '{"kind": "approved", "body": "verified with the corrected contract — passes"}',
          ].join('\n'),
        },
        url: 'http://localhost:4100/health/live',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
