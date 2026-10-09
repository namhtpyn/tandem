import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false, // shared DB — serial by file
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.TANDEM_E2E_URL || 'http://localhost:4100',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.TANDEM_E2E_NO_SERVER
    ? undefined
    : {
        command: 'PORT=4100 DATABASE_URL=postgresql://tandem:tandem@127.0.0.1:55432/tandem_e2e bun .output/server/index.mjs',
        url: 'http://localhost:4100/health/live',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
})
