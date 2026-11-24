// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, devices } from '@playwright/test';

import './env-loader';

import { hashApiKey, TEST_API_KEY } from './src/__tests__/helpers/auth';
import { openApiBaseUrl } from './src/__tests__/helpers/workflows';

const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const apiBaseUrl = process.env.VITE_API_URL || 'http://localhost:3000';

/** The first API's database (`DATABASE_URL`, else the API's local default) with `_open` after its name. */
function openDatabaseUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL || 'postgres://canyonos:canyonos@localhost:5432/canyonos'
  );
  url.pathname = `${url.pathname}_open`;
  return url.toString();
}

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
  // so the open API creates its database only once the first entry has Postgres up.
  // Neither API is reused: one a developer left running may have seeded other keys, or none.
  webServer: [
    // Beside the seeded workflow groups, the first API finds a self-hosted one as it starts: the
    // Global Controller the script stands in for publishes its identity and its key's hash to
    // the Redis at CANYONOS_REDIS_HOST:CANYONOS_REDIS_PORT (`bun run docker:up` starts one).
    {
      command: process.env.CI
        ? 'cd ../.. && bun packages/web/scripts/self-hosted-controller.ts && PORT=3000 API_URL=http://localhost:3000 bun --filter @canyonos/api start'
        : 'cd ../.. && bun run docker:up && bun packages/web/scripts/self-hosted-controller.ts && bun --filter @canyonos/api dev:server',
      url: `${apiBaseUrl}/v1/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        SEED_DEV_DATA: 'true',
        SEED_DEV_API_KEY_HASH: hashApiKey(TEST_API_KEY),
        CANYONOS_REDIS_HOST: process.env.CANYONOS_REDIS_HOST ?? '127.0.0.1',
        CANYONOS_REDIS_PORT: process.env.CANYONOS_REDIS_PORT ?? '6379',
        // The dashboard runs no workflow group; with Docker disabled /v1/readyz waits on the
        // database alone, on a machine with a Docker engine or without one.
        DOCKER_SOCKET: '',
      },
    },
    // Whether a workflow group is open is stored with it, so the open API needs a database of its
    // own, made empty for each run, whose seeded groups have no key, and a Redis nothing listens
    // on, so the self-hosted controller's keyed workflow group never reaches it.
    {
      command: process.env.CI
        ? 'cd ../.. && bun packages/web/scripts/fresh-database.ts && bun --filter @canyonos/api start'
        : 'cd ../.. && bun packages/web/scripts/fresh-database.ts && bun --filter @canyonos/api dev:server',
      url: `${openApiBaseUrl}/v1/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATABASE_URL: openDatabaseUrl(),
        SEED_DEV_DATA: 'true',
        SEED_DEV_API_KEY_HASH: '',
        CANYONOS_REDIS_HOST: '127.0.0.1',
        CANYONOS_REDIS_PORT: '1',
        PORT: new URL(openApiBaseUrl).port,
        API_URL: openApiBaseUrl,
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
