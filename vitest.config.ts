import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps,tools}/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
