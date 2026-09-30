import { defineConfig, devices } from '@playwright/test';

import './env-loader';

const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const apiBaseUrl = process.env.VITE_API_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './src/__tests__',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  maxFailures: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60_000,
  use: {
    baseURL: webBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Keep API and dashboard as separately supervised processes. A root Turbo dev process can stay
  // alive while its API child is still starting (or has exited), causing Playwright to time out
  // without exposing the actual readiness failure.
  webServer: [
    {
      command: process.env.CI
        ? 'cd ../.. && PORT=3000 API_URL=http://localhost:3000 bun --filter @canyonos/api start'
        : 'cd ../.. && bun run docker:up && bun --filter @canyonos/api dev:server',
      url: `${apiBaseUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { ...process.env, SEED_DEV_DATA: 'true' },
    },
    {
      command: process.env.CI
        ? 'cd ../.. && VITE_API_URL=http://localhost:3000 bun --filter web dev'
        : 'cd ../.. && bun --filter web dev',
      url: webBaseUrl,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  expect: { timeout: 10_000 },
});
