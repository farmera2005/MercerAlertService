import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running stack, e.g.
 *   docker compose --profile dev up -d --build
 *   E2E_SETUP_CODE=$(docker compose logs web | grep -o '"setupCode":"[^"]*"' | tail -1 | cut -d'"' -f4) \
 *     pnpm --filter @mercer/web test:e2e
 * The setup spec needs a FRESH install (no admin yet); the dashboard spec runs after it and drives
 * mock-swis through its control API (E2E_MOCK_CONTROL_URL, default http://127.0.0.1:17774).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'setup', testMatch: /setup\.spec\.ts/ },
    { name: 'dashboard', testMatch: /dashboard\.spec\.ts/, dependencies: ['setup'] },
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
    ...devices['Desktop Chrome'],
    // Use an already-installed Chromium (e.g. a CI image) instead of `playwright install`.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
});
