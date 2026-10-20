import { defineConfig } from 'oxlint';
export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  categories: {
    restriction: 'error',
    correctness: 'error',
  },
  rules: {},
  env: {
    builtin: true,
  },
});
