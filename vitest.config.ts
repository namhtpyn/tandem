import { fileURLToPath } from 'node:url';

import { defineVitestProject } from '@nuxt/test-utils/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // server code imports shared/ via nuxt's #shared alias — vitest needs it too
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '#server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  test: {
    hookTimeout: 60_000,
    testTimeout: 15_000,
    // a spy/stub leak between tests is a false green — restore after every test
    restoreMocks: true,
    unstubGlobals: true,
    // no shared fixtures between files — shuffling keeps hidden coupling from hiding
    sequence: { shuffle: true },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      // unit + e2e only (owner ruling 2026-10-28: the integration project is gone).
      // The gate covers the APP layer — server behavior is verified end-to-end by
      // the e2e suite against the real built server, not by a coverage number.
      include: ['app/composables/**/*.ts', 'app/utils/**/*.ts'],
      exclude: [
        '**/types/**', // type-only modules
        '**/*.d.ts',
        'app/utils/orpc-types.ts', // type-only module (InferClientOutputs projections)
      ],
      thresholds: {
        // bun 1.4.4's V8 counts every ??/?. arm as its own branch and mis-attributes
        // branches to schema-declaration lines — the phantom floor measured stable at
        // ~97.3 branches / ~99.7 statements across runs (owner ruling 2026-10-27: (b)).
        // A real untested function/line still moves these by whole percents.
        statements: 99.5,
        branches: 97,
        functions: 99.5,
        lines: 99.5,
      },
    },
    projects: [
      {
        // pure tests: no database, no real I/O — must stay millisecond-fast.
        // `import.meta.client` is only faked here: the nuxt project gets the real
        // values from the Nuxt environment, and server code must not be told it
        // is running in a browser.
        define: {
          'import.meta.client': 'true',
          'import.meta.server': 'false',
        },
        // unit tests import app modules that use the nuxt '~' alias — resolve it
        // HERE only; the nuxt project must keep its own alias semantics
        resolve: { alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) } },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      // component tests in a real Nuxt environment (auto-imports, plugins, injections)
      // — mountSuspended etc. Docs: defineVitestProject is only for nuxt-env tests.
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['test/nuxt/**/*.test.ts'],
          environment: 'nuxt',
          // explicit coverage opt-out: only 3 components mount here, and without
          // this block the project INHERITS the root collector — the nuxt module
          // graph then re-records app/composables+utils as uncovered (0-24%) and
          // craters the global threshold (CI red at 95.3% vs 99.5%)
          coverage: { enabled: false, reporter: [], reportsDirectory: null, thresholds: {} },
        },
      }),
    ],
  },
});
