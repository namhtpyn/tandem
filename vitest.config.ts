import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'import.meta.client': 'true',
    'import.meta.server': 'false',
  },
  test: {
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'], // e2e/ belongs to Playwright, not vitest

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'server/**/*.ts',
        'app/composables/**/*.ts',
        'app/utils/**/*.ts',
      ],
      exclude: [
        'server/db/schema.ts', // declarative table defs — exercised via integration
        'server/db/test-client.ts', // test scaffolding
        'server/utils/auth-hash.ts', // barrel: pure re-export of better-auth's hasher
        '**/types/**', // type-only modules
        '**/*.d.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
