import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      // Only with --coverage (npm run test:coverage). Counts what the tests run in this
      // process: the entry points are exercised in child processes, so they read as uncovered.
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
