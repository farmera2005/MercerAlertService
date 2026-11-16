import { defineConfig } from 'vitest/config';

// Integration tests need a throwaway Postgres: DATABASE_URL_TEST=postgres://.../mas_test
export default defineConfig({
  test: {
    include: ['{packages,apps,tools}/*/src/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
