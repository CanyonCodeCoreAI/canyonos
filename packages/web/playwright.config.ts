// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, devices } from '@playwright/test';

import './env-loader';

import { hashApiKey, TEST_API_KEY } from './src/__tests__/helpers/auth';
import { noAuthApiBaseUrl } from './src/__tests__/helpers/workflows';

const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const apiBaseUrl = process.env.VITE_API_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './src/__tests__',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
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
  // without exposing the actual readiness failure. Playwright starts the entries one after another,
  // so the keyless API boots only after the first one has migrated and seeded the database.
  // Neither API is reused: one a developer left running may hold another key, or none.
  webServer: [
    {
      command: process.env.CI
        ? 'cd ../.. && PORT=3000 API_URL=http://localhost:3000 bun --filter @canyonos/api start'
        : 'cd ../.. && bun run docker:up && bun --filter @canyonos/api dev:server',
      url: `${apiBaseUrl}/v1/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        CANYONOS_API_KEY_HASH: hashApiKey(TEST_API_KEY),
        SEED_DEV_DATA: 'true',
        // The dashboard runs no workflow group; with Docker disabled /v1/readyz waits on the
        // database alone, on a machine with a Docker engine or without one.
        DOCKER_SOCKET: '',
      },
    },
    {
      command: process.env.CI
        ? 'cd ../.. && bun --filter @canyonos/api start'
        : 'cd ../.. && bun --filter @canyonos/api dev:server',
      url: `${noAuthApiBaseUrl}/v1/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        CANYONOS_API_KEY_HASH: '',
        PORT: new URL(noAuthApiBaseUrl).port,
        API_URL: noAuthApiBaseUrl,
        DOCKER_SOCKET: '',
      },
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
