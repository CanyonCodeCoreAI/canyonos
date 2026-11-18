// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';

export const AUTH_STORAGE_KEY = 'cc-auth-storage';

/**
 * The API key `playwright.config.ts` starts the API with. Its space, `+`, `&`, `=` and `%` make
 * every sign-in link percent-encode it, as `canyonos dashboard` does.
 */
export const TEST_API_KEY = 'canyonos e2e+key&=%2B';

/** The `CANYONOS_API_KEY_HASH` of `key`. */
export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

/** The persisted store as the dashboard writes it. */
export const storedApiKey = (apiKey: string | null) => ({ state: { apiKey }, version: 0 });

/** Stores `apiKey` once per tab, before the app boots, so a later sign-out or refusal sticks. */
export async function setApiKey(page: Page, apiKey: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('e2e-api-key-set')) return;
      sessionStorage.setItem('e2e-api-key-set', '1');
      localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, JSON.stringify(storedApiKey(apiKey))] as const
  );
}

export const readStoredApiKey = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTH_STORAGE_KEY);

/** Boots the app holding the API key. */
export async function authenticate(page: Page): Promise<void> {
  await setApiKey(page, TEST_API_KEY);
}
