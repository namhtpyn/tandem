import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // ONE worker, both locally and in CI: every spec shares the same e2e
  // database, so parallel workers only race truncates and login state (and at
  // 4+ they starved the app server into random login/fill timeouts). The
  // shared-DB serial promise is the config's contract — no worker env tuning.
  workers: 1,
  testDir: './test/e2e',
  timeout: 60_000,
  fullyParallel: false, // shared DB — serial by file
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.TANDEM_E2E_URL || 'http://localhost:4100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.TANDEM_E2E_NO_SERVER
    ? undefined
    : {
        command: `PORT=4100 TANDEM_FAKE_RUNNER=1 REDIS_URL=${process.env.TANDEM_E2E_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6399'} TANDEM_PUBLIC_URL=http://localhost:4100 TANDEM_VAULT_KEY=${process.env.TANDEM_E2E_VAULT_KEY || Buffer.alloc(32, 7).toString('base64')} TANDEM_ATTACHMENTS_DIR=${process.env.TANDEM_E2E_ATTACHMENTS_DIR || '/tmp/tandem-e2e-attachments'} DATABASE_URL=${process.env.TANDEM_E2E_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_e2e'} bun .output/server/index.mjs`,
        env: {
          TANDEM_E2E_DATABASE_URL:
            process.env.TANDEM_E2E_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_e2e',
        },
        url: 'http://localhost:4100/health/live',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
