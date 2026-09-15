import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests.
 *
 * These exist for the things the API tests cannot see: that a dispatcher can
 * actually complete a trip intake on a phone-sized screen, that the offer
 * countdown appears, that the job card is readable offline, and that the
 * navigation reaches every screen. They run against a real API and a real
 * build, because a component test that mocks the server proves nothing about
 * whether the two agree.
 *
 * `webServer` is not used: the API and the database are started by the caller
 * (scripts/e2e.sh locally, the workflow in CI), so a failure to start shows up
 * as a clear error rather than a Playwright timeout.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Chromium is preinstalled in the container image; do not download one.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      // The screen most volunteers actually use. Deliberately first: if the
      // phone layout is broken, that is the failure that matters most.
      name: 'phone',
      use: { ...devices['Pixel 7'] },
      dependencies: ['setup'],
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      dependencies: ['setup'],
    },
  ],
});
