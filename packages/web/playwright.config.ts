// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import './env-loader';

import { noAuthApiBaseUrl } from './src/__tests__/helpers/projects';

/**
 * Makes this run's key pair while the config loads, before Playwright starts the API with its
 * `webServer.env`: the API trusts the public half, the specs sign with the private half. Workers
 * load the config again and inherit the paths, so they keep the runner's pair.
 */
function trustTestKey(): string {
  const keysDir = join(import.meta.dirname, '.playwright');
  const trustedDir = join(keysDir, 'trusted');
  if (process.env.PRIVATE_KEY_PATH && process.env.TRUSTED_KEYS_DIR) return trustedDir;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(trustedDir, { recursive: true });
  const privateKeyPath = join(keysDir, 'e2e.key');
  writeFileSync(join(trustedDir, 'e2e.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  process.env.PRIVATE_KEY_PATH = privateKeyPath;
  process.env.TRUSTED_KEYS_DIR = trustedDir;
  return trustedDir;
}

const trustedKeysDir = trustTestKey();

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
  // so the switched-off API boots only after the first one has migrated and seeded the database.
  // Neither API is reused: one a developer left running does not trust this run's key.
  webServer: [
    {
      command: process.env.CI
        ? 'cd ../.. && PORT=3000 API_URL=http://localhost:3000 bun --filter @canyonos/api start'
        : 'cd ../.. && bun run docker:up && bun --filter @canyonos/api dev:server',
      url: `${apiBaseUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...process.env, AUTH_TRUSTED_KEYS_DIR: trustedKeysDir, SEED_DEV_DATA: 'true' },
    },
    {
      command: process.env.CI
        ? 'cd ../.. && bun --filter @canyonos/api start'
        : 'cd ../.. && bun --filter @canyonos/api dev:server',
      url: `${noAuthApiBaseUrl}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        AUTH_DISABLED: 'true',
        PORT: new URL(noAuthApiBaseUrl).port,
        API_URL: noAuthApiBaseUrl,
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
