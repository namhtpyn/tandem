import { defineConfig } from 'oxlint';
export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'vue', 'typescript', 'vitest', 'eslint', 'import', 'promise', 'node'],
  categories: {
    restriction: 'error',
    correctness: 'error',
  },
  rules: {
    'typescript/explicit-function-return-type': 'off',
    'typescript/explicit-module-boundary-types': 'off',
    'eslint/no-undefined': 'off',
    'oxc/no-async-await': 'off',
    'oxc/no-rest-spread-properties': 'off',
    'oxc/no-optional-chaining': 'off',
    'eslint/no-eq-null': 'off',

    'import/no-default-export': 'off',
    'node/no-top-level-await': 'off',

    'node/no-process-env': 'off',
    'unicorn/no-process-exit': 'off',

    'eslint/no-use-before-define': 'off',
  },
  env: {
    builtin: true,
  },
});
