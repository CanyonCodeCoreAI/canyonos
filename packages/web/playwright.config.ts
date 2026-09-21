import { defineConfig, devices } from '@playwright/test';

import './env-loader';

const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const apiBaseUrl = process.env.VITE_API_URL || 'http://localhost:3000';
// CanyonOS local mode is a build-time flag, so proving it needs a second dashboard build rather
// than a second browser context. Its specs live apart from the default ones and never mix: the
// default project ignores them, and this project takes only them.
const localModeBaseUrl = process.env.PLAYWRIGHT_CANYONOS_BASE_URL || 'http://localhost:5175';
const localModePort = new URL(localModeBaseUrl).port;
const CANYONOS_SPECS = /[\\/]__tests__[\\/]canyonos[\\/].*\.spec\.ts$/;

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: CANYONOS_SPECS },
    {
      name: 'canyonos-local',
      use: { ...devices['Desktop Chrome'], baseURL: localModeBaseUrl },
      testMatch: CANYONOS_SPECS,
    },
  ],
  // Keep API and dashboard as separately supervised processes. A root Turbo dev process can stay
  // alive while its API child is still starting (or has exited), causing Playwright to time out
  // without exposing the actual readiness failure.
  webServer: [
    {
      command: process.env.CI
        ? 'cd ../.. && PORT=3000 API_URL=http://localhost:3000 WORKFLOW_GENERATION_STUB=true bun --filter @cc-forge/api start'
        : 'cd ../.. && bun run docker:up && WORKFLOW_GENERATION_STUB=true bun --filter @cc-forge/api dev:server',
      url: `${apiBaseUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { ...process.env, SEED_DEV_DATA: 'true', DEPLOY_MOCK_STEP_MS: '400' },
    },
    {
      command: process.env.CI
        ? 'cd ../.. && VITE_API_URL=http://localhost:3000 bun --filter web dev'
        : 'cd ../.. && bun --filter web dev',
      url: webBaseUrl,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    // The same dashboard with the local-mode flag on, against the one API above. Vite lets a
    // `VITE_*` process variable win over the `.env` file, so this build is flagged on whatever the
    // checked-out env says.
    {
      command: 'cd ../.. && bun --filter web dev',
      url: localModeBaseUrl,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        VITE_API_URL: apiBaseUrl,
        VITE_CANYONOS_LOCAL_MODE: 'true',
        VITE_WEB_PORT: localModePort,
      },
    },
  ],
  expect: { timeout: 10_000 },
});
